import type { IncomingMessage } from "node:http";
import WebSocket from "ws";
import {
  nextConnectionFailure,
  type ConnectionStateReason
} from "./connection-state";
import { authorizedFetch } from "./management-fetch";
import { wrapOAuthState } from "./oauth-state";
import {
  CONNECTION_RETRY_MAX_DELAY_MS,
  sleepUntilAborted,
  tunnelConnectionAbortedError
} from "./connection-retry";
import { managementSubscriberPath, publicIngressUrl, joinTargetUrl } from "./ingress-urls";
import { ROUTER_HEADER_CONNECTION } from "./router-headers";
import { DEREGISTER_TIMEOUT_MS, DELIVERY_TIMEOUT_MS } from "./subscriber-lifetime";
import {
  TUNNEL_HELLO_TIMEOUT_MS,
  TUNNEL_PING,
  TUNNEL_PING_INTERVAL_MS,
  TUNNEL_PONG,
  TUNNEL_PONG_DEADLINE_MS,
  decodeBody,
  encodeBody,
  headersFromPairs,
  isTunnelHello,
  isTunnelRequest,
  managementOAuthStatePath,
  managementTunnelPath,
  parseJsonMessage,
  serializeHeaders,
  toWebSocketUrl,
  tunnelSubprotocol,
  type TunnelRequestMessage
} from "./tunnel-protocol";
import type { Connection } from "./dev-router-types";

/** Reverse-tunnel sidecar: outbound WebSocket that serves local HTTP. */
export class TunnelConnection implements Connection {
  subscriberId = "";
  readonly routeId: string;
  readonly targetBaseUrl: string;
  readonly publicUrl: string;
  readonly transport = "tunnel" as const;
  forwardToken = "";
  connectionToken = "";
  connectionState: ConnectionStateReason = "connecting";
  readonly environmentId?: string;
  readonly acceptWebhooks: boolean;

  private readonly routerUrl: string;
  private readonly secret: string;
  private lastPongAt = 0;
  private readonly closed = new AbortController();
  private disconnected = false;
  private loopStarted = false;
  private serving = false;
  private socket: WebSocket | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private markReady: () => void = () => undefined;
  private failReady: (error: Error) => void = () => undefined;
  private readySettled = false;
  private readonly ready: Promise<void>;
  private readonly onSignal = (): void => {
    void this.disconnect();
  };

  constructor(options: {
    routerUrl: string;
    secret: string;
    routeId: string;
    localUrl: string;
    environmentId?: string;
    acceptWebhooks?: boolean;
  }) {
    this.routerUrl = options.routerUrl;
    this.secret = options.secret;
    this.routeId = options.routeId;
    this.targetBaseUrl = options.localUrl;
    this.publicUrl = publicIngressUrl(options.routerUrl, options.routeId);
    this.environmentId = options.environmentId;
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
    void this.runLoop();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  async start(): Promise<void> {
    this.begin();
    await this.ready;
  }

  get connected(): boolean {
    return this.serving && this.socket?.readyState === WebSocket.OPEN;
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.serving = false;
    this.connectionState = "disconnected";
    this.clearPing();
    process.off("SIGINT", this.onSignal);
    process.off("SIGTERM", this.onSignal);
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState === WebSocket.OPEN) {
      await closeSocket(socket);
    } else if (socket) {
      socket.terminate();
    }
    if (this.subscriberId) {
      try {
        await authorizedFetch(
          this.routerUrl,
          this.connectionToken || this.secret,
          managementSubscriberPath(this.routeId, this.subscriberId),
          { method: "DELETE", signal: AbortSignal.timeout(DEREGISTER_TIMEOUT_MS) }
        );
      } catch {
        // WebSocket close already removed the subscriber.
      }
    }
    this.closed.abort();
    this.failReady(tunnelConnectionAbortedError());
  }

  async wrapOAuthState(inner?: string): Promise<string> {
    return wrapOAuthState({
      secret: this.secret,
      subscriberId: this.subscriberId,
      routeId: this.routeId,
      inner
    });
  }

  async bindOAuthState(state: string): Promise<void> {
    const response = await authorizedFetch(
      this.routerUrl,
      this.connectionToken || this.secret,
      managementOAuthStatePath(this.routeId, this.subscriberId),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
        signal: this.closed.signal
      }
    );
    if (!response.ok) {
      throw new Error(`bindOAuthState failed: ${response.status}`);
    }
  }

  private async runLoop(): Promise<void> {
    let delay = 1_000;
    while (!this.disconnected) {
      try {
        await this.openAndServe();
        delay = 1_000;
      } catch (error) {
        this.noteFailure(error);
        if (this.disconnected || this.closed.signal.aborted) {
          this.failReady(error instanceof Error ? error : tunnelConnectionAbortedError());
          return;
        }
        await sleepUntilAborted(delay, this.closed.signal, tunnelConnectionAbortedError).catch(
          () => undefined
        );
        delay = Math.min(delay * 2, CONNECTION_RETRY_MAX_DELAY_MS);
      }
    }
  }

  private async openAndServe(): Promise<void> {
    const url = toWebSocketUrl(
      `${this.routerUrl}${managementTunnelPath(this.routeId, this.environmentId, this.acceptWebhooks)}`
    );
    const headers: Record<string, string> = {};
    if (this.connectionToken) {
      headers[ROUTER_HEADER_CONNECTION] = this.connectionToken;
    }
    const socket = new WebSocket(url, [tunnelSubprotocol(this.secret)], { headers });
    this.socket = socket;
    socket.on("unexpected-response", (_request, response: IncomingMessage) => {
      this.noteFailure(undefined, response.statusCode);
      response.resume();
      socket.terminate();
    });
    await waitForOpen(socket, this.closed.signal);
    await this.waitForHello(socket);
    this.serving = true;
    this.connectionState = "connected";
    this.markReady();
    this.startPing(socket);
    try {
      await this.serve(socket);
    } finally {
      this.serving = false;
      this.clearPing();
      if (this.socket === socket) {
        this.socket = undefined;
      }
      if (!this.disconnected && this.connectionState === "connected") {
        this.connectionState = "connecting";
      }
    }
  }

  private noteFailure(error: unknown, statusCode?: number): void {
    if (this.disconnected) {
      this.connectionState = "disconnected";
      return;
    }
    const next = nextConnectionFailure(this.connectionState, error, statusCode);
    this.connectionState = next;
  }

  private waitForHello(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("tunnel hello timeout"));
      }, TUNNEL_HELLO_TIMEOUT_MS);

      const onAbort = (): void => {
        cleanup();
        reject(tunnelConnectionAbortedError());
      };

      const onMessage = (data: WebSocket.RawData): void => {
        const text = rawToString(data);
        if (text === TUNNEL_PONG) {
          this.lastPongAt = Date.now();
          return;
        }
        if (text === TUNNEL_PING) {
          return;
        }
        try {
          const parsed = parseJsonMessage(text);
          if (!isTunnelHello(parsed)) {
            return;
          }
          this.subscriberId = parsed.subscriberId;
          this.forwardToken = parsed.forwardToken;
          this.connectionToken = parsed.connectionToken ?? "";
          cleanup();
          resolve();
        } catch {
          cleanup();
          reject(new Error("invalid tunnel hello"));
        }
      };

      const onClose = (): void => {
        cleanup();
        reject(new Error("tunnel closed before hello"));
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        this.closed.signal.removeEventListener("abort", onAbort);
        socket.off("message", onMessage);
        socket.off("close", onClose);
        socket.off("error", onError);
      };

      this.closed.signal.addEventListener("abort", onAbort, { once: true });
      socket.on("message", onMessage);
      socket.once("close", onClose);
      socket.once("error", onError);
    });
  }

  private serve(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMessage = (data: WebSocket.RawData): void => {
        void this.handleMessage(socket, rawToString(data));
      };
      socket.on("message", onMessage);
      socket.once("close", () => {
        socket.off("message", onMessage);
        resolve();
      });
      socket.once("error", (error) => {
        socket.off("message", onMessage);
        reject(error);
      });
    });
  }

  private async handleMessage(socket: WebSocket, text: string): Promise<void> {
    if (text === TUNNEL_PONG) {
      this.lastPongAt = Date.now();
      return;
    }
    if (text === TUNNEL_PING) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonMessage(text);
    } catch {
      return;
    }
    if (!isTunnelRequest(parsed)) {
      return;
    }
    try {
      const response = await this.forwardLocal(parsed);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(response));
      }
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "error",
            id: parsed.id,
            code: "local_fetch_failed",
            message: error instanceof Error ? error.message : "local_fetch_failed"
          })
        );
      }
    }
  }

  private async forwardLocal(message: TunnelRequestMessage): Promise<{
    type: "response";
    id: string;
    status: number;
    headers: [string, string][];
    body?: string;
  }> {
    const url = joinTargetUrl(this.targetBaseUrl, message.path, message.search);
    const headers = headersFromPairs(message.headers);
    headers.delete("host");
    const init: RequestInit = {
      method: message.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
    };
    if (message.method !== "GET" && message.method !== "HEAD") {
      const body = decodeBody(message.body);
      if (body.byteLength > 0) {
        init.body = body;
      }
    }
    const response = await fetch(url, init);
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      type: "response",
      id: message.id,
      status: response.status,
      headers: serializeHeaders(response.headers),
      body: encodeBody(body)
    };
  }

  private startPing(socket: WebSocket): void {
    this.clearPing();
    this.lastPongAt = Date.now();
    let ticks = 0;
    this.pingTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (Date.now() - this.lastPongAt > TUNNEL_PONG_DEADLINE_MS) {
        socket.terminate();
        return;
      }
      socket.send(TUNNEL_PING);
      ticks += 1;
      if (ticks % 2 === 0) {
        socket.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, TUNNEL_PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }
}

function rawToString(data: WebSocket.RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

function waitForOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      socket.terminate();
      reject(tunnelConnectionAbortedError());
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("tunnel closed before open"));
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, DEREGISTER_TIMEOUT_MS);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close(1000, "client disconnect");
  });
}
