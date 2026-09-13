export const HEARTBEAT_INTERVAL_MS = 60_000;
export const SUBSCRIBER_TTL_MS = 300_000;
export const DELIVERY_TIMEOUT_MS = 10_000;

export const ROUTER_HEADER_ROUTE = "X-Dev-Router-Route";
export const ROUTER_HEADER_SUBSCRIBER = "X-Dev-Router-Subscriber";
export const ROUTER_HEADER_REQUEST_ID = "X-Dev-Router-Request-Id";
export const ROUTER_HEADER_SECRET = "X-Dev-Router-Secret";

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
  "content-length"
]);

export class TargetBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetBaseUrlError";
  }
}

export function validateTargetBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TargetBaseUrlError("targetBaseUrl must be an absolute URL");
  }

  if (url.protocol !== "https:") {
    throw new TargetBaseUrlError("targetBaseUrl must use https://");
  }
  if (url.username || url.password) {
    throw new TargetBaseUrlError("targetBaseUrl must not contain credentials");
  }
  if (url.hash) {
    throw new TargetBaseUrlError("targetBaseUrl must not contain a fragment");
  }

  return url.toString();
}

const DEFAULT_ROUTE_OBJECT_NAME = "dev-router:default";

export function isValidRouteId(routeId: string): boolean {
  return routeId.length > 0 && routeId !== "_router" && /^[A-Za-z0-9._~-]+$/.test(routeId);
}

export function isAllowedRouteId(routeId: string): boolean {
  return routeId === "" || isValidRouteId(routeId);
}

export function durableObjectNameForRoute(routeId: string): string {
  return routeId === "" ? DEFAULT_ROUTE_OBJECT_NAME : routeId;
}

export function managementSubscriberPath(
  routeId: string,
  subscriberId?: string,
  suffix?: string
): string {
  const base =
    routeId === ""
      ? "/_router/subscribers"
      : `/_router/routes/${encodeURIComponent(routeId)}/subscribers`;
  if (!subscriberId) {
    return base;
  }
  const subscriberPath = `${base}/${encodeURIComponent(subscriberId)}`;
  return suffix ? `${subscriberPath}/${suffix}` : subscriberPath;
}

export function publicIngressUrl(routerUrl: string, routeId: string): string {
  const base = routerUrl.replace(/\/+$/, "");
  return routeId === "" ? `${base}/*` : `${base}/${routeId}/*`;
}

export function joinTargetUrl(
  targetBaseUrl: string,
  remainingPath: string,
  search: string
): string {
  const base = new URL(targetBaseUrl);
  const remaining = remainingPath.startsWith("/") ? remainingPath : `/${remainingPath}`;
  const basePath = base.pathname.replace(/\/+$/, "");
  const suffix = remaining === "/" ? "/" : remaining;
  base.pathname = `${basePath}${suffix}` || "/";
  base.search = search.startsWith("?") ? search.slice(1) : search;
  return base.toString();
}

export function remainingPathFromPublicUrl(pathname: string, routeId: string): string {
  if (routeId === "") {
    return pathname || "/";
  }
  const prefix = `/${routeId}`;
  if (pathname === prefix) {
    return "";
  }
  if (pathname.startsWith(`${prefix}/`)) {
    return pathname.slice(prefix.length);
  }
  return pathname;
}

export function shouldForwardHeader(name: string): boolean {
  return !HOP_BY_HOP_HEADERS.has(name.toLowerCase());
}
