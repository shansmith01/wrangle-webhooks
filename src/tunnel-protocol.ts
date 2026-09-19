export const TUNNEL_PROTOCOL_VERSION = 1;
export const TUNNEL_PING = "ping";
export const TUNNEL_PONG = "pong";
export const TUNNEL_SUBPROTOCOL_PREFIX = "dev-router.v1.";
export const TUNNEL_MAX_BODY_BYTES = 768 * 1024;
export const TUNNEL_HELLO_TIMEOUT_MS = 10_000;
export const TUNNEL_PING_INTERVAL_MS = 30_000;
export const TUNNEL_PONG_DEADLINE_MS = 75_000;
/** Milliseconds without a tunnel ping/pong before the Worker closes the socket. */
export const TUNNEL_STALE_MS = 90_000;

export type HeaderPair = [string, string];

export interface TunnelHelloMessage {
  type: "hello";
  v: typeof TUNNEL_PROTOCOL_VERSION;
  subscriberId: string;
  routeId: string;
  forwardToken: string;
  connectionToken?: string;
  environmentId?: string;
}

export interface TunnelHeartbeatMessage {
  type: "heartbeat";
}

export interface TunnelRequestMessage {
  type: "request";
  id: string;
  method: string;
  path: string;
  search: string;
  headers: HeaderPair[];
  body?: string;
}

export interface TunnelResponseMessage {
  type: "response";
  id: string;
  status: number;
  headers: HeaderPair[];
  body?: string;
}

export interface TunnelErrorMessage {
  type: "error";
  id: string;
  code: string;
  message: string;
}

export type TunnelServerMessage = TunnelHelloMessage | TunnelRequestMessage;
export type TunnelClientMessage = TunnelResponseMessage | TunnelErrorMessage;

export function managementTunnelPath(
  routeId: string,
  environmentId?: string,
  acceptWebhooks = true
): string {
  const path =
    routeId === ""
      ? "/_router/tunnel"
      : `/_router/routes/${encodeURIComponent(routeId)}/tunnel`;
  const params = new URLSearchParams();
  if (environmentId) {
    params.set("environmentId", environmentId);
  }
  if (!acceptWebhooks) {
    params.set("acceptWebhooks", "0");
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function managementCredentialPath(routeId: string): string {
  return routeId === ""
    ? "/_router/credential"
    : `/_router/routes/${encodeURIComponent(routeId)}/credential`;
}

export function managementOAuthStatePath(routeId: string, subscriberId: string): string {
  const base =
    routeId === ""
      ? "/_router/subscribers"
      : `/_router/routes/${encodeURIComponent(routeId)}/subscribers`;
  return `${base}/${encodeURIComponent(subscriberId)}/oauth-states`;
}

export function routeIdFromTunnelPath(pathname: string): string | null {
  if (pathname === "/_router/tunnel") {
    return "";
  }
  const match = pathname.match(/^\/_router\/routes\/([^/]+)\/tunnel$/);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1]);
}

export function toWebSocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function tunnelSubprotocol(secret: string): string {
  return `${TUNNEL_SUBPROTOCOL_PREFIX}${bytesToBase64Url(new TextEncoder().encode(secret))}`;
}

export function decodeTunnelSubprotocolSecret(protocolHeader: string | null): string | null {
  if (!protocolHeader) {
    return null;
  }
  for (const part of protocolHeader.split(",")) {
    const token = part.trim();
    if (!token.startsWith(TUNNEL_SUBPROTOCOL_PREFIX)) {
      continue;
    }
    try {
      return new TextDecoder().decode(
        base64UrlToBytes(token.slice(TUNNEL_SUBPROTOCOL_PREFIX.length))
      );
    } catch {
      return null;
    }
  }
  return null;
}

export function encodeBody(buffer: ArrayBuffer | Uint8Array): string | undefined {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength === 0) {
    return undefined;
  }
  return Buffer.from(bytes).toString("base64");
}

export function decodeBody(value: string | undefined): Uint8Array {
  if (!value) {
    return new Uint8Array(0);
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function serializeHeaders(headers: Headers): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") {
      return;
    }
    pairs.push([name, value]);
  });
  if (typeof headers.getSetCookie === "function") {
    for (const cookie of headers.getSetCookie()) {
      pairs.push(["Set-Cookie", cookie]);
    }
  }
  return pairs;
}

export function headersFromPairs(pairs: HeaderPair[]): Headers {
  const headers = new Headers();
  for (const [name, value] of pairs) {
    headers.append(name, value);
  }
  return headers;
}

export function parseJsonMessage(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

export function isTunnelHello(value: unknown): value is TunnelHelloMessage {
  return isRecord(value) && value.type === "hello" && typeof value.subscriberId === "string";
}

export function isTunnelHeartbeat(value: unknown): value is TunnelHeartbeatMessage {
  return isRecord(value) && value.type === "heartbeat";
}

export function isTunnelRequest(value: unknown): value is TunnelRequestMessage {
  return isRecord(value) && value.type === "request" && typeof value.id === "string";
}

export function isTunnelResponse(value: unknown): value is TunnelResponseMessage {
  return isRecord(value) && value.type === "response" && typeof value.id === "string";
}

export function isTunnelError(value: unknown): value is TunnelErrorMessage {
  return isRecord(value) && value.type === "error" && typeof value.id === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}
