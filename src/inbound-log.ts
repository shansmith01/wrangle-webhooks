/** How long inbound request metadata is kept (7 days, milliseconds). */
export const INBOUND_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum inbound request metadata events stored on the router index. */
export const INBOUND_LOG_MAX_EVENTS = 5000;

/** How many inbound request events the dashboard returns (newest first). */
export const INBOUND_LOG_DASHBOARD_LIMIT = 200;

/** Stored inbound path length cap (characters); query string is never included. */
export const INBOUND_LOG_PATH_MAX_LENGTH = 256;

/** Webhook fan-out vs OAuth callback proxy for an inbound public request. */
export type InboundLogKind = "webhook" | "oauth";

/** Public outcome of an inbound request, not subscriber delivery success. */
export type InboundLogResult = "accepted" | "proxied" | "rejected";

/** Allowlisted public error code stored on a rejected inbound request. */
export type InboundLogError =
  | "route_not_found"
  | "oauth_unroutable"
  | "oauth_subscriber_not_found"
  | "oauth_callback_incomplete"
  | "oauth_callback_not_registered"
  | "oauth_method_not_allowed"
  | "request_too_large"
  | "subscriber_unreachable";

/** One inbound public request, metadata only (no body, query, or headers). */
export interface InboundLogEvent {
  id: string;
  occurredAt: number;
  method: string;
  routeId: string | null;
  path: string;
  hasQuery: boolean;
  kind: InboundLogKind;
  result: InboundLogResult;
  status: number;
  error: InboundLogError | null;
  subscriberCount: number;
  deliveredSubscriberCount: number;
  bodyBytes: number;
}

/** Fields recorded when a public webhook or OAuth callback hits the Worker. */
export interface InboundLogEventInput {
  id: string;
  method: string;
  routeId?: string | null;
  remainingPath: string;
  search?: string;
  kind: InboundLogKind;
  result: InboundLogResult;
  status: number;
  error?: string | null;
  subscriberCount: number;
  deliveredSubscriberCount?: number;
  bodyBytes: number;
  occurredAt?: number;
}

const KINDS = new Set<string>(["webhook", "oauth"]);
const RESULTS = new Set<string>(["accepted", "proxied", "rejected"]);
const ERRORS = new Set<string>([
  "route_not_found",
  "oauth_unroutable",
  "oauth_subscriber_not_found",
  "oauth_callback_incomplete",
  "oauth_callback_not_registered",
  "oauth_method_not_allowed",
  "request_too_large",
  "subscriber_unreachable"
]);

/** Build a metadata-only inbound log row: path without query, no headers or body. */
export function buildInboundLogEvent(input: InboundLogEventInput): InboundLogEvent {
  return {
    id: sanitizeInboundRequestId(input.id),
    occurredAt: input.occurredAt ?? Date.now(),
    method: sanitizeHttpMethod(input.method),
    routeId: sanitizeInboundRouteId(input.routeId),
    path: sanitizeInboundPath(input.remainingPath),
    hasQuery: inboundHasQuery(input.search ?? ""),
    kind: KINDS.has(input.kind) ? input.kind : "webhook",
    result: RESULTS.has(input.result) ? input.result : "rejected",
    status: sanitizeInboundStatus(input.status),
    error: sanitizeInboundError(input.error),
    subscriberCount: sanitizeInboundCount(input.subscriberCount),
    deliveredSubscriberCount: sanitizeInboundCount(input.deliveredSubscriberCount ?? 0),
    bodyBytes: sanitizeInboundBodyBytes(input.bodyBytes)
  };
}

/** True when the inbound URL had a query string; values are never stored. */
export function inboundHasQuery(search: string): boolean {
  const value = search.startsWith("?") ? search.slice(1) : search;
  return value.length > 0;
}

/** Strip query string, fragment, and newlines from an inbound path before storing metadata. */
export function sanitizeInboundPath(value: string): string {
  const withoutQuery = value.split("?")[0]?.split("#")[0] ?? "/";
  if (!withoutQuery || /[\r\n]/.test(withoutQuery)) {
    return "/";
  }
  const path = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  const trimmed = path.slice(0, INBOUND_LOG_PATH_MAX_LENGTH) || "/";
  return trimmed;
}

/** Keep a plausible HTTP method token; drop header-injection characters. */
export function sanitizeHttpMethod(value: string): string {
  const method = value.trim().toUpperCase();
  if (/^[A-Z]{1,16}$/.test(method)) {
    return method;
  }
  return "UNKNOWN";
}

/** Public HTTP status on the Worker response (100-599). */
export function sanitizeInboundStatus(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const status = Math.floor(value);
  if (status < 100 || status > 599) {
    return 0;
  }
  return status;
}

/** Byte length of the inbound body, or a sanitized Content-Length when the body was not read. */
export function inboundBodyBytes(request: Request, body?: ArrayBuffer): number {
  if (body) {
    return sanitizeInboundBodyBytes(body.byteLength);
  }
  const header = request.headers.get("Content-Length");
  if (!header || !/^\d{1,12}$/.test(header.trim())) {
    return 0;
  }
  return sanitizeInboundBodyBytes(Number(header.trim()));
}

/** Reject oversized or empty request ids before storing inbound metadata. */
export function sanitizeInboundRequestId(value: string): string {
  const trimmed = value.trim();
  if (/^req_[a-z0-9]{8,32}$/i.test(trimmed)) {
    return trimmed;
  }
  return "req_invalid";
}

function sanitizeInboundRouteId(routeId: string | null | undefined): string | null {
  if (routeId == null) {
    return null;
  }
  if (routeId === "") {
    return "";
  }
  if (routeId.length > 128 || /[^A-Za-z0-9._~-]/.test(routeId)) {
    return null;
  }
  return routeId;
}

function sanitizeInboundError(value: string | null | undefined): InboundLogError | null {
  if (!value || !ERRORS.has(value)) {
    return null;
  }
  return value as InboundLogError;
}

function sanitizeInboundCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(10_000, Math.floor(value)));
}

function sanitizeInboundBodyBytes(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1_000_000_000, Math.floor(value)));
}

/** Compact size label for the inbound request table (bytes or kibibytes). */
export function formatInboundBodyBytes(bodyBytes: number): string {
  const bytes = sanitizeInboundBodyBytes(bodyBytes);
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}
