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

/** Whether this header should be copied onto the forwarded subscriber request. */
export function shouldForwardHeader(name: string): boolean {
  return !HOP_BY_HOP_HEADERS.has(name.toLowerCase());
}
