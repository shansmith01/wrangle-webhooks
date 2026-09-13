import { detectPublicDevUrl } from "./detect-url";
import { authorizedFetch } from "./management-fetch";
import { wrapOAuthState } from "./oauth-state";
import {
  DEREGISTER_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  TargetBaseUrlError,
  isAllowedEnvironmentId,
  isAllowedRouteId,
  managementSubscriberPath,
  publicIngressUrl,
  validateLocalUrl,
  validateTargetBaseUrl
} from "./shared";
import { TunnelConnection } from "./tunnel-client";
import { managementOAuthStatePath } from "./tunnel-protocol";
import type {
  ConnectOptions,
  Connection,
  DevRouterClientOptions,
  RegisterSubscriberResponse
} from "./types";

export { startControlServer, CONTROL_DEFAULT_PORT } from "./control-server";
export type { ControlServer, ControlServerOptions } from "./control-server";
export { deriveRouteSecret } from "./credentials";
export { detectPublicDevUrl, resolveDevPort } from "./detect-url";
export type { DetectedPublicUrl } from "./detect-url";
export { wrapOAuthState } from "./oauth-state";
export type { Connection, ConnectOptions, DevRouterClientOptions } from "./types";

const MAX_RETRY_DELAY_MS = 30_000;

export class DevRouterClient {
  readonly routerUrl: string;
  readonly secret: string;

  constructor(options: DevRouterClientOptions) {
    if (!options.routerUrl) {
      throw new Error("routerUrl is required");
    }
    if (!options.secret) {
      throw new Error("secret is required");
    }
    this.routerUrl = options.routerUrl.replace(/\/+$/, "");
    this.secret = options.secret;
  }

  async connect(options: ConnectOptions = {}): Promise<Connection> {
    const routeId = resolveRouteId(options);
    if (options.localUrl && options.targetBaseUrl) {
      throw new Error("localUrl and targetBaseUrl are mutually exclusive");
    }
    if (options.localUrl) {
      const connection = new TunnelConnection({
        routerUrl: this.routerUrl,
        secret: this.secret,
        routeId,
        localUrl: validateLocalUrl(options.localUrl),
        environmentId: resolveEnvironmentId(options)
      });
      await connection.start();
      return connection;
    }

    const targetBaseUrl = resolveTargetBaseUrl(options);
    validateTargetBaseUrl(targetBaseUrl);

    const connection = new PublicConnection(this, {
      ...options,
      routeId,
      targetBaseUrl
    });
    await connection.start();
    return connection;
  }
}

class PublicConnection implements Connection {
  subscriberId = "";
  readonly routeId: string;
  readonly targetBaseUrl: string;
  readonly publicUrl: string;
  readonly transport = "public" as const;
  forwardToken = "";
  connectionToken = "";
  readonly environmentId?: string;

  private readonly client: DevRouterClient;
  private readonly closed = new AbortController();
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private disconnected = false;
  private readonly onSignal = (): void => {
    void this.disconnect();
  };

  constructor(
    client: DevRouterClient,
    options: ConnectOptions & { routeId: string; targetBaseUrl: string }
  ) {
    this.client = client;
    this.routeId = options.routeId;
    this.targetBaseUrl = options.targetBaseUrl;
    this.publicUrl = publicIngressUrl(client.routerUrl, options.routeId);
    this.environmentId = resolveEnvironmentId(options);
  }

  async start(): Promise<void> {
    const registered = await retry(() => this.register(), this.closed.signal);
    this.subscriberId = registered.subscriberId;
    this.forwardToken = registered.forwardToken;
    this.connectionToken = registered.connectionToken;
    this.scheduleHeartbeat();
    process.on("SIGINT", this.onSignal);
    process.on("SIGTERM", this.onSignal);
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }
    process.off("SIGINT", this.onSignal);
    process.off("SIGTERM", this.onSignal);
    if (this.subscriberId) {
      try {
        await this.request(managementSubscriberPath(this.routeId, this.subscriberId), {
          method: "DELETE",
          signal: AbortSignal.timeout(DEREGISTER_TIMEOUT_MS)
        });
      } catch {
        // TTL cleanup handles a failed deregister.
      }
    }
    this.closed.abort();
  }

  async wrapOAuthState(inner?: string): Promise<string> {
    return wrapOAuthState({
      secret: this.client.secret,
      subscriberId: this.subscriberId,
      routeId: this.routeId,
      inner
    });
  }

  async bindOAuthState(state: string): Promise<void> {
    const response = await this.request(
      managementOAuthStatePath(this.routeId, this.subscriberId),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state })
      }
    );
    if (!response.ok) {
      throw new Error(`bindOAuthState failed: ${response.status}`);
    }
  }

  private async register(): Promise<RegisterSubscriberResponse> {
    const response = await this.request(managementSubscriberPath(this.routeId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetBaseUrl: this.targetBaseUrl,
        ...(this.environmentId ? { environmentId: this.environmentId } : {})
      })
    });
    if (!response.ok) {
      throw new RetryableError(`registration failed: ${response.status}`);
    }
    const payload = (await response.json()) as RegisterSubscriberResponse;
    return {
      ...payload,
      forwardToken: payload.forwardToken ?? "",
      connectionToken: payload.connectionToken ?? ""
    };
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = setTimeout(() => {
      void this.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private async heartbeat(): Promise<void> {
    if (this.disconnected) {
      return;
    }
    try {
      const response = await this.request(
        managementSubscriberPath(this.routeId, this.subscriberId, "heartbeat"),
        { method: "POST" }
      );
      if (response.status === 404) {
        const registered = await this.register();
        this.subscriberId = registered.subscriberId;
        this.forwardToken = registered.forwardToken;
        this.connectionToken = registered.connectionToken;
      } else if (!response.ok) {
        throw new RetryableError(`heartbeat failed: ${response.status}`);
      }
    } catch (error) {
      if (this.disconnected) {
        return;
      }
      if (!(error instanceof TargetBaseUrlError)) {
        // Stay alive and try again on the next interval.
      }
    }
    if (!this.disconnected) {
      this.scheduleHeartbeat();
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const subscriberScoped =
      path.includes("/subscribers/") && this.connectionToken.length > 0;
    return authorizedFetch(
      this.client.routerUrl,
      subscriberScoped ? this.connectionToken : this.client.secret,
      path,
      {
        ...init,
        signal: init.signal ?? this.closed.signal
      }
    );
  }
}

class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

async function retry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let delay = 1_000;
  for (;;) {
    if (signal.aborted) {
      throw new Error("connection aborted");
    }
    try {
      return await fn();
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      await sleep(delay, signal);
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("connection aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("connection aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveRouteId(options: ConnectOptions): string {
  const routeId = options.routeId ?? "";
  if (!isAllowedRouteId(routeId)) {
    throw new Error("routeId is invalid");
  }
  return routeId;
}

function resolveEnvironmentId(options: ConnectOptions): string | undefined {
  const environmentId = options.environmentId ?? process.env.DEV_ROUTER_ENVIRONMENT_ID;
  if (!environmentId) {
    return undefined;
  }
  if (!isAllowedEnvironmentId(environmentId)) {
    throw new Error("environmentId is invalid");
  }
  return environmentId;
}

function resolveTargetBaseUrl(options: ConnectOptions): string {
  if (options.targetBaseUrl) {
    return options.targetBaseUrl;
  }
  return detectPublicDevUrl(process.env, options.port).url;
}
