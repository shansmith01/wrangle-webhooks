export const HEARTBEAT_INTERVAL_MS = 60_000;
export const SUBSCRIBER_TTL_MS = 300_000;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const DEREGISTER_TIMEOUT_MS = 5_000;
export const ENVIRONMENT_ID_MAX_LENGTH = 128;
export const TUNNEL_STALE_MS = 90_000;

export const ROUTER_HEADER_ROUTE = "X-Dev-Router-Route";
export const ROUTER_HEADER_SUBSCRIBER = "X-Dev-Router-Subscriber";
export const ROUTER_HEADER_REQUEST_ID = "X-Dev-Router-Request-Id";
export const ROUTER_HEADER_TOKEN = "X-Dev-Router-Token";

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

export class LocalUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalUrlError";
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

export function validateLocalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalUrlError("localUrl must be an absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LocalUrlError("localUrl must use http:// or https://");
  }
  if (url.username || url.password) {
    throw new LocalUrlError("localUrl must not contain credentials");
  }
  if (url.hash) {
    throw new LocalUrlError("localUrl must not contain a fragment");
  }

  return url.toString();
}

const DEFAULT_ROUTE_OBJECT_NAME = "dev-router:default";
const ROUTER_INDEX_OBJECT_NAME = "dev-router:index";
const RESERVED_ROUTE_IDS = new Set(["_router", "dashboard"]);

export function isValidRouteId(routeId: string): boolean {
  return (
    routeId.length > 0 &&
    !RESERVED_ROUTE_IDS.has(routeId) &&
    /^[A-Za-z0-9._~-]+$/.test(routeId)
  );
}

export function durableObjectNameForIndex(): string {
  return ROUTER_INDEX_OBJECT_NAME;
}

export function isAllowedRouteId(routeId: string): boolean {
  return routeId === "" || isValidRouteId(routeId);
}

export function isAllowedEnvironmentId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= ENVIRONMENT_ID_MAX_LENGTH &&
    /^[A-Za-z0-9._~:@+-]+$/.test(value)
  );
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

export function forwardingDisplayUrl(targetBaseUrl: string): string {
  return `${targetBaseUrl.replace(/\/+$/, "")}/*`;
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
