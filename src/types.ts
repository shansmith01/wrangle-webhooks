export type SubscriberTransport = "public" | "tunnel";

export interface Subscriber {
  id: string;
  transport: SubscriberTransport;
  targetBaseUrl: string;
  createdAt: number;
  lastHeartbeatAt: number;
  expiresAt: number;
}

export interface RegisterSubscriberResponse {
  subscriberId: string;
  routeId: string;
  expiresIn: number;
  forwardToken: string;
}

export interface DevRouterClientOptions {
  routerUrl: string;
  secret: string;
}

export interface ConnectOptions {
  routeId?: string;
  targetBaseUrl?: string;
  localUrl?: string;
  port?: number;
}

export interface Connection {
  subscriberId: string;
  routeId: string;
  targetBaseUrl: string;
  publicUrl: string;
  transport: SubscriberTransport;
  forwardToken: string;
  disconnect(): Promise<void>;
  wrapOAuthState(inner?: string): Promise<string>;
  bindOAuthState(state: string): Promise<void>;
}

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
