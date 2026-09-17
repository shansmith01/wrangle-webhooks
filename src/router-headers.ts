/** Public ingress header naming the matched route id. */
export const ROUTER_HEADER_ROUTE = "X-Dev-Router-Route";

/** Public ingress header naming the chosen subscriber id. */
export const ROUTER_HEADER_SUBSCRIBER = "X-Dev-Router-Subscriber";

/** Public ingress header naming this request's id. */
export const ROUTER_HEADER_REQUEST_ID = "X-Dev-Router-Request-Id";

/** Public ingress header carrying the subscriber's forward token. */
export const ROUTER_HEADER_TOKEN = "X-Dev-Router-Token";

/** Tunnel WebSocket header carrying the subscriber connection token. */
export const ROUTER_HEADER_CONNECTION = "X-Dev-Router-Connection";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "authorization",
  "cookie",
  "set-cookie"
]);

/** Client-supplied forwarding headers an attacker can spoof (`X-Original-URL`, `X-Real-IP`). */
const SPOOFED_FORWARD_HEADERS = new Set([
  "cf-connecting-ip",
  "forwarded",
  "true-client-ip",
  "x-client-ip",
  "x-dev-router-connection",
  "x-dev-router-request-id",
  "x-dev-router-route",
  "x-dev-router-secret",
  "x-dev-router-subscriber",
  "x-dev-router-token",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-server",
  "x-originating-ip",
  "x-original-url",
  "x-real-ip",
  "x-rewrite-url"
]);

/** Whether this header should be copied onto the forwarded subscriber request. */
export function shouldForwardHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return !HOP_BY_HOP_HEADERS.has(lower) && !SPOOFED_FORWARD_HEADERS.has(lower);
}
