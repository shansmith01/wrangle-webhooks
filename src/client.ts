import { detectPublicDevUrl } from "./detect-url";
import {
  nextConnectionFailure,
  type ConnectionStateReason
} from "./connection-state";
import {
  publicConnectionAbortedError,
  retryUntilAborted,
  RetryableConnectionError
} from "./connection-retry";
import { authorizedFetch } from "./management-fetch";
import { wrapOAuthState } from "./oauth-state";
import { managementSubscriberPath, publicIngressUrl } from "./ingress-urls";
import { isAllowedEnvironmentId, isAllowedRouteId } from "./route-id";
import { DEREGISTER_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS } from "./subscriber-lifetime";
import { TargetBaseUrlError, validateTargetBaseUrl } from "./target-base-url";
import { validateLocalUrl } from "./local-url";
import { TunnelConnection } from "./tunnel-client";
import { managementOAuthStatePath } from "./tunnel-protocol";
import type {
  ConnectOptions,
  Connection,
  DevRouterClientOptions,
  RegisterSubscriberResponse
} from "./dev-router-types";

export { startControlServer, CONTROL_DEFAULT_PORT } from "./control-server";
export type { ControlServer, ControlServerOptions } from "./control-server";
export type { ConnectionStateReason } from "./connection-state";
export { deriveRouteSecret } from "./credentials";
export { detectPublicDevUrl, resolveDevPort } from "./detect-url";
export type { DetectedPublicUrl } from "./detect-url";
export { wrapOAuthState } from "./oauth-state";
export type { Connection, ConnectOptions, DevRouterClientOptions } from "./dev-router-types";

/** Sidecar that registers a subscriber on the shared Worker and keeps it alive. */
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
    const connection = this.open(options);
    await connection.whenReady();
    return connection;
  }

  open(options: ConnectOptions = {}): Connection {
    const connection = this.createConnection(options);
    connection.begin();
    return connection;
  }

  private createConnection(options: ConnectOptions): TunnelConnection | PublicConnection {
    const routeId = resolveRouteId(options);
    if (options.localUrl && options.targetBaseUrl) {
      throw new Error("localUrl and targetBaseUrl are mutually exclusive");
    }
    if (options.localUrl) {
      return new TunnelConnection({
        routerUrl: this.routerUrl,
        secret: this.secret,
        routeId,
        localUrl: validateLocalUrl(options.localUrl),
        environmentId: resolveEnvironmentId(options),
        acceptWebhooks: options.acceptWebhooks
      });
    }

    const targetBaseUrl = resolveTargetBaseUrl(options);
    validateTargetBaseUrl(targetBaseUrl);

    return new PublicConnection(this, {
      ...options,
      routeId,
      targetBaseUrl
    });
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
  connectionState: ConnectionStateReason = "connecting";
  readonly environmentId?: string;
  readonly acceptWebhooks: boolean;

  get connected(): boolean {
    return !this.disconnected && this.subscriberId.length > 0;
  }

  private readonly client: DevRouterClient;
  private readonly closed = new AbortController();
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private disconnected = false;
  private loopStarted = false;
  private readySettled = false;
  private markReady: () => void = () => undefined;
  private failReady: (error: Error) => void = () => undefined;
  private readonly ready: Promise<void>;
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
    this.acceptWebhooks = options.acceptWebhooks !== false;
    this.ready = new Promise<void>((resolve, reject) => {
      this.markReady = () => {
        if (this.readySettled) {
          return;
        }
        this.readySettled = true;
        resolve();
      };
      this.failReady = (error) => {
        if (this.readySettled) {
          return;
        }
        this.readySettled = true;
        reject(error);
      };
    });
    void this.ready.catch(() => undefined);
  }

  begin(): void {
    if (this.loopStarted) {
      return;
    }
    this.loopStarted = true;
    process.on("SIGINT", this.onSignal);
    process.on("SIGTERM", this.onSignal);
    void this.runStart();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  async start(): Promise<void> {
    this.begin();
    await this.ready;
  }

  private async runStart(): Promise<void> {
    try {
      const registered = await retryUntilAborted(
        () => this.register(),
        this.closed.signal,
        publicConnectionAbortedError
      );
      this.subscriberId = registered.subscriberId;
      this.forwardToken = registered.forwardToken;
      this.connectionToken = registered.connectionToken;
      this.connectionState = "connected";
      this.scheduleHeartbeat();
      this.markReady();
    } catch (error) {
      this.failReady(error instanceof Error ? error : publicConnectionAbortedError());
    }
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.connectionState = "disconnected";
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
    this.failReady(publicConnectionAbortedError());
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
    let response: Response;
    try {
      response = await this.request(managementSubscriberPath(this.routeId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetBaseUrl: this.targetBaseUrl,
        ...(this.environmentId ? { environmentId: this.environmentId } : {}),
        ...(this.connectionToken ? { connectionToken: this.connectionToken } : {}),
        ...(this.acceptWebhooks ? {} : { acceptWebhooks: false })
      })
      });
    } catch (error) {
      this.connectionState = nextConnectionFailure(this.connectionState, error);
      throw error;
    }
    if (!response.ok) {
      this.connectionState = nextConnectionFailure(
        this.connectionState,
        undefined,
        response.status
      );
      throw new RetryableConnectionError(`registration failed: ${response.status}`);
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
        throw new RetryableConnectionError(`heartbeat failed: ${response.status}`);
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
