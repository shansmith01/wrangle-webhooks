import { detectPublicDevUrl } from "./detect-url";
import {
  HEARTBEAT_INTERVAL_MS,
  TargetBaseUrlError,
  isAllowedRouteId,
  managementSubscriberPath,
  publicIngressUrl,
  validateTargetBaseUrl
} from "./shared";
import type {
  ConnectOptions,
  Connection,
  DevRouterClientOptions,
  RegisterSubscriberResponse
} from "./types";

export { detectPublicDevUrl, resolveDevPort } from "./detect-url";
export type { DetectedPublicUrl } from "./detect-url";

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
    const targetBaseUrl = resolveTargetBaseUrl(options);
    validateTargetBaseUrl(targetBaseUrl);

    const connection = new RouterConnection(this, {
      ...options,
      routeId,
      targetBaseUrl
    });
    await connection.start();
    return connection;
  }
}

class RouterConnection implements Connection {
  subscriberId = "";
  readonly routeId: string;
  readonly targetBaseUrl: string;
  readonly publicUrl: string;

  private readonly client: DevRouterClient;
  private readonly abort = new AbortController();
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
  }

  async start(): Promise<void> {
    const registered = await retry(
      () => this.register(),
      this.abort.signal
    );
    this.subscriberId = registered.subscriberId;
    this.scheduleHeartbeat();
    process.on("SIGINT", this.onSignal);
    process.on("SIGTERM", this.onSignal);
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.abort.abort();
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }
    process.off("SIGINT", this.onSignal);
    process.off("SIGTERM", this.onSignal);
    if (!this.subscriberId) {
      return;
    }
    try {
      await this.request(
        managementSubscriberPath(this.routeId, this.subscriberId),
        { method: "DELETE" }
      );
    } catch {
      // TTL cleanup handles a failed deregister.
    }
  }

  private async register(): Promise<RegisterSubscriberResponse> {
    const response = await this.request(
      managementSubscriberPath(this.routeId),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetBaseUrl: this.targetBaseUrl })
      }
    );
    if (!response.ok) {
      throw new RetryableError(`registration failed: ${response.status}`);
    }
    return (await response.json()) as RegisterSubscriberResponse;
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
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.client.secret}`);
    return fetch(`${this.client.routerUrl}${path}`, {
      ...init,
      headers,
      signal: this.abort.signal
    });
  }
}

class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

async function retry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
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

function resolveTargetBaseUrl(options: ConnectOptions): string {
  if (options.targetBaseUrl) {
    return options.targetBaseUrl;
  }
  const detected = detectPublicDevUrl(process.env, options.port);
  if (!detected) {
    throw new Error(
      "Could not detect this environment's public URL. Cloud development environments usually expose it automatically (for example GitHub Codespaces or VS Code tunnels). Set PUBLIC_DEV_URL or pass --target if you need an override."
    );
  }
  return detected.url;
}
