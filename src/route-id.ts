/** Maximum length of a stable cloud environment id. */
export const ENVIRONMENT_ID_MAX_LENGTH = 128;

const DEFAULT_ROUTE_OBJECT_NAME = "dev-router:default";
const ROUTER_INDEX_OBJECT_NAME = "dev-router:index";
const RESERVED_ROUTE_IDS = new Set(["_router", "dashboard"]);

/** Whether `routeId` is a non-empty public path prefix (not `_router` or `dashboard`). */
export function isValidRouteId(routeId: string): boolean {
  return (
    routeId.length > 0 &&
    !RESERVED_ROUTE_IDS.has(routeId) &&
    /^[A-Za-z0-9._~-]+$/.test(routeId)
  );
}

/** Durable Object name for the router-wide index of active routes. */
export function durableObjectNameForIndex(): string {
  return ROUTER_INDEX_OBJECT_NAME;
}

/** Whether `routeId` may be used, including the empty root catch-all. */
export function isAllowedRouteId(routeId: string): boolean {
  return routeId === "" || isValidRouteId(routeId);
}

/** Whether `value` is a stable environment id (reconnect identity). */
export function isAllowedEnvironmentId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= ENVIRONMENT_ID_MAX_LENGTH &&
    /^[A-Za-z0-9._~:@+-]+$/.test(value)
  );
}

/** Durable Object name for the RouteDurableObject that owns this route id. */
export function durableObjectNameForRoute(routeId: string): string {
  return routeId === "" ? DEFAULT_ROUTE_OBJECT_NAME : routeId;
}
