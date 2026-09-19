import { isScannerProbePath } from "./scanner-probe";
import { publicPathHasDotDotSegment } from "./ingress-urls";

/** Maximum accepted length of an allowlisted OAuth callback remaining path. */
export const OAUTH_CALLBACK_PATH_MAX_LENGTH = 256;

/** One admin-registered OAuth callback remaining path for a route. */
export interface OAuthCallbackPathRow {
  routeId: string;
  remainingPath: string;
  createdAt: number;
}

/** Normalize a remaining path for allowlist storage and exact match (trailing slash stripped). */
export function normalizeOAuthCallbackPath(path: string): string {
  const withoutQuery = path.split("?")[0]?.split("#")[0] ?? "";
  const trimmed = withoutQuery.trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "") || "/";
}

/**
 * Validate an OAuth callback remaining path for admin registration.
 * Remaining path only: starts with `/`, no host/query/hash/glob/`..`, not a scanner probe.
 */
export function validateOAuthCallbackPath(path: string): string | null {
  if (typeof path !== "string" || path.length === 0 || path.length > OAUTH_CALLBACK_PATH_MAX_LENGTH) {
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
  const normalized = normalizeOAuthCallbackPath(path);
  if (normalized.length > OAUTH_CALLBACK_PATH_MAX_LENGTH) {
    return null;
  }
  return normalized;
}

/** True when the remaining path is exactly one of the allowlisted OAuth callback paths. */
export function isAllowlistedOAuthCallbackPath(
  remainingPath: string,
  allowedPaths: readonly string[]
): boolean {
  if (allowedPaths.length === 0) {
    return false;
  }
  const normalized = normalizeOAuthCallbackPath(remainingPath);
  return allowedPaths.some((allowed) => normalizeOAuthCallbackPath(allowed) === normalized);
}

/**
 * True when the remaining path looks like an OAuth or auth callback.
 * Used only to reject unregistered callback-shaped traffic (not to grant reverse proxy).
 */
export function looksLikeOAuthCallbackPath(remainingPath: string): boolean {
  const path = normalizeOAuthCallbackPath(remainingPath);
  return /\/(oauth|auth)\/callback(?:\/|$)/i.test(path);
}
