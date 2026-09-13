export interface Subscriber {
  id: string;
  targetBaseUrl: string;
  createdAt: number;
  lastHeartbeatAt: number;
  expiresAt: number;
}

export interface RegisterSubscriberResponse {
  subscriberId: string;
  routeId: string;
  expiresIn: number;
}

export interface DevRouterClientOptions {
  routerUrl: string;
  secret: string;
}

export interface ConnectOptions {
  routeId: string;
  targetBaseUrl: string;
}

export interface Connection {
  subscriberId: string;
  routeId: string;
  targetBaseUrl: string;
  publicUrl: string;
  disconnect(): Promise<void>;
}
