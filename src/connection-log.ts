import type { SubscriberTransport } from "./dev-router-types";

/** How long connection audit events are kept (90 days, milliseconds). */
export const CONNECTION_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Maximum connection audit events stored on the router index. */
export const CONNECTION_LOG_MAX_EVENTS = 2000;

/** How many connection audit events the dashboard returns (newest first). */
export const CONNECTION_LOG_DASHBOARD_LIMIT = 200;

/** What happened in a historical client connection audit event. */
export type ConnectionLogAction = "connected" | "disconnected" | "rejected";

/** Why a connection audit event was recorded. */
export type ConnectionLogReason =
  | "registered"
  | "reclaimed"
  | "replaced"
  | "deregistered"
  | "socket_closed"
  | "expired"
  | "stale_tunnel"
  | "unauthorized"
  | "environment_in_use";

/** One historical client connection event for operator audit. */
export interface ConnectionLogEvent {
  id: string;
  occurredAt: number;
  action: ConnectionLogAction;
  reason: ConnectionLogReason;
  routeId: string;
  subscriberId: string | null;
  environmentId: string | null;
  transport: SubscriberTransport | null;
  targetBaseUrl: string | null;
  clientIp: string | null;
}

/** Fields recorded when a sidecar connects, disconnects, or is rejected. */
export interface ConnectionLogEventInput {
  action: ConnectionLogAction;
  reason: ConnectionLogReason;
  routeId: string;
  subscriberId?: string | null;
  environmentId?: string | null;
  transport?: SubscriberTransport | null;
  targetBaseUrl?: string | null;
  clientIp?: string | null;
  occurredAt?: number;
}

/** Cloudflare connecting IP from CF-Connecting-IP, if it looks like an address. */
export function clientIpFromRequest(request: Request): string | null {
  return sanitizeClientIp(request.headers.get("CF-Connecting-IP"));
}

/** Reject oversized or empty CF-Connecting-IP values before storing an audit event. */
export function sanitizeClientIp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    return null;
  }
  if (/[\r\n]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/** Public dashboard path for a stored route id, including the root catch-all. */
export function publicPathForRouteId(routeId: string): string {
  return routeId === "" ? "/*" : `/${routeId}/*`;
}

/** Target shown in the connection audit log (reverse-tunnel, not a Worker-visible URL). */
export function connectionLogTargetBaseUrl(
  transport: SubscriberTransport | string | null | undefined,
  targetBaseUrl: string | null | undefined
): string | null {
  if (transport === "tunnel") {
    return "reverse-tunnel";
  }
  return targetBaseUrl || null;
}
