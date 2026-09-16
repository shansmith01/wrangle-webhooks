import type { ConnectionStateReason } from "./connection-state";

export type { ConnectionStateReason } from "./connection-state";

/** How the Worker reaches this subscriber: public HTTPS fetch or reverse tunnel. */
export type SubscriberTransport = "public" | "tunnel";

/** Active subscriber recorded on a route Durable Object. */
export interface Subscriber {
  id: string;
  transport: SubscriberTransport;
  targetBaseUrl: string;
  createdAt: number;
  lastHeartbeatAt: number;
  expiresAt: number;
  environmentId: string | null;
}

/** JSON body returned when a sidecar registers a subscriber. */
export interface RegisterSubscriberResponse {
  subscriberId: string;
  routeId: string;
  expiresIn: number;
  forwardToken: string;
  connectionToken: string;
}

/** Constructor options for the sidecar client. */
export interface DevRouterClientOptions {
  routerUrl: string;
  secret: string;
}

/** Options for opening a public-target or reverse-tunnel connection. */
export interface ConnectOptions {
  routeId?: string;
  targetBaseUrl?: string;
  localUrl?: string;
  port?: number;
  environmentId?: string;
}

/** Live sidecar subscription to a shared Worker route. */
export interface Connection {
  subscriberId: string;
  routeId: string;
  targetBaseUrl: string;
  publicUrl: string;
  transport: SubscriberTransport;
  forwardToken: string;
  connectionToken: string;
  environmentId?: string;
  readonly connected: boolean;
  readonly connectionState: ConnectionStateReason;
  whenReady(): Promise<void>;
  disconnect(): Promise<void>;
  wrapOAuthState(inner?: string): Promise<string>;
  bindOAuthState(state: string): Promise<void>;
}

/** Public HTTP request captured by the Worker for fan-out or OAuth proxy. */
export interface IngressPayload {
  remainingPath: string;
  search: string;
  method: string;
  headerPairs: [string, string][];
  bodyBase64?: string;
  requestId: string;
  publicHost: string;
  publicProto: string;
  clientIp: string | null;
  oauthState: string | null;
}

/** Result of proxying an OAuth callback to a single subscriber. */
export type ProxyResult =
  | {
      kind: "proxy";
      status: number;
      headers: [string, string][];
      bodyBase64?: string;
    }
  | {
      kind: "error";
      status: number;
      error: string;
      message?: string;
    };
