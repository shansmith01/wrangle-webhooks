/** Management API path for subscriber register, heartbeat, or deregister. */
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

/** Public ingress URL pattern advertised for this router and route id. */
export function publicIngressUrl(routerUrl: string, routeId: string): string {
  const base = routerUrl.replace(/\/+$/, "");
  return routeId === "" ? `${base}/*` : `${base}/${routeId}/*`;
}

/** Human-readable target URL pattern shown in the CLI (not fetched as-is). */
export function forwardingDisplayUrl(targetBaseUrl: string): string {
  return `${targetBaseUrl.replace(/\/+$/, "")}/*`;
}

/** Join remaining public path and query onto the subscriber's target base URL. */
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

/** True when a public remaining path contains a `..` path-traversal segment after decode. */
export function publicPathHasDotDotSegment(pathname: string): boolean {
  let current = pathname;
  for (let i = 0; i < 4; i++) {
    if (pathSegmentsIncludeDotDot(current)) {
      return true;
    }
    const decoded = decodePublicPathnameOnce(current);
    if (decoded === current) {
      break;
    }
    current = decoded;
  }
  return pathSegmentsIncludeDotDot(current);
}

function decodePublicPathnameOnce(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function pathSegmentsIncludeDotDot(pathname: string): boolean {
  const normalized = pathname.replace(/\\/g, "/");
  for (const segment of normalized.split("/")) {
    const withoutParams = segment.replace(/;.*$/, "");
    if (withoutParams === "..") {
      return true;
    }
  }
  return false;
}

/** Strip the public route id prefix from an inbound pathname. */
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
