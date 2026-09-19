import { isScannerProbePath } from "./scanner-probe";
import { publicPathHasDotDotSegment } from "./ingress-urls";
import { isAllowedEnvironmentId } from "./route-id";

/** Maximum accepted length of a webhook fan-out remaining-path prefix. */
export const WEBHOOK_FILTER_PATH_MAX_LENGTH = 256;

/** Allowlist (`only`) or denylist (`skip`) for webhook fan-out remaining paths. */
export type WebhookFanoutRuleMode = "allow" | "deny";

/** Normalize a remaining path for webhook prefix storage and match (trailing slash stripped). */
export function normalizeWebhookFilterPath(path: string): string {
  const withoutQuery = path.split("?")[0]?.split("#")[0] ?? "";
  const trimmed = withoutQuery.trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "") || "/";
}

/**
 * Validate a webhook fan-out remaining-path prefix for operator storage.
 * Remaining path only: starts with `/`, not exactly `/`, no host/query/hash/glob/`..`, not a scanner probe.
 */
export function validateWebhookFilterPath(path: string): string | null {
  if (typeof path !== "string" || path.length === 0 || path.length > WEBHOOK_FILTER_PATH_MAX_LENGTH) {
    return null;
  }
  if (/[\r\n\0]/.test(path) || path.includes("*") || path.includes("?") || path.includes("#")) {
    return null;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) || path.includes("//")) {
    return null;
  }
  if (!path.startsWith("/")) {
    return null;
  }
  if (publicPathHasDotDotSegment(path) || isScannerProbePath(path)) {
    return null;
  }
  const normalized = normalizeWebhookFilterPath(path);
  if (normalized === "/" || normalized.length > WEBHOOK_FILTER_PATH_MAX_LENGTH) {
    return null;
  }
  return normalized;
}

/** Parse `allow` or `deny` from operator JSON or a dashboard form. */
export function validateWebhookFanoutRuleMode(mode: string): WebhookFanoutRuleMode | null {
  if (mode === "allow" || mode === "deny") {
    return mode;
  }
  return null;
}

/**
 * Parse an optional environment-id scope for a webhook fan-out rule.
 * Empty means all subscribers on the route; invalid ids are rejected.
 */
export function parseWebhookFilterEnvironmentId(
  value: string | null | undefined
): { ok: true; environmentId: string | null } | { ok: false } {
  if (value == null) {
    return { ok: true, environmentId: null };
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return { ok: true, environmentId: null };
  }
  if (!isAllowedEnvironmentId(trimmed)) {
    return { ok: false };
  }
  return { ok: true, environmentId: trimmed };
}
