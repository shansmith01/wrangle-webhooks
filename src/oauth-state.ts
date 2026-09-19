import { hmacSha256Base64Url } from "./hmac-sha256";
import {
  isAllowlistedOAuthCallbackPath,
  looksLikeOAuthCallbackPath
} from "./oauth-callback-path";
import { timingSafeEqualString } from "./timing-safe-equal";

export { looksLikeOAuthCallbackPath } from "./oauth-callback-path";

/** Prefix on signed OAuth `state` values minted by the sidecar. */
export const OAUTH_STATE_PREFIX = "dr1.";
/** Milliseconds a signed OAuth state remains valid. */
export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
/** Maximum accepted length of an OAuth state string. */
export const OAUTH_STATE_MAX_LENGTH = 2_048;

/** Payload inside a signed `dr1.` OAuth state. */
export interface SignedOAuthState {
  v: 1;
  sub: string;
  route: string;
  exp: number;
  d?: string;
}

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthStateError";
  }
}

/** Public delivery class: OAuth proxy, webhook fan-out, or a rejected callback. */
export type DeliveryClass =
  | "oauth"
  | "fanout"
  | "oauth_callback_incomplete"
  | "oauth_callback_not_registered"
  | "oauth_method_not_allowed";

/** True when the HTTP method is a GET or POST OAuth callback (not PUT/PATCH/DELETE). */
export function isOAuthCallbackMethod(method: string): boolean {
  const upper = method.trim().toUpperCase();
  return upper === "GET" || upper === "POST";
}

/** @deprecated Use looksLikeOAuthCallbackPath — regex no longer grants reverse proxy. */
export function isOAuthCallbackPath(remainingPath: string): boolean {
  return looksLikeOAuthCallbackPath(remainingPath);
}

/** True when query or form includes an OAuth `code` or `error` result. */
export function hasOAuthCodeOrError(
  search: string,
  form: URLSearchParams | null
): boolean {
  const { code, error } = oauthCallbackResultParams(search, form);
  return Boolean(code || error);
}

/**
 * Choose OAuth proxy vs webhook fan-out from allowlist, path heuristic, query, form, and method.
 * Only admin-allowlisted remaining paths are reverse-proxied. Heuristic callback paths and
 * signed `dr1.` state on non-allowlisted paths are rejected with no fan-out.
 */
export function classifyDelivery(options: {
  remainingPath: string;
  search: string;
  form: URLSearchParams | null;
  method?: string;
  allowedCallbackPaths?: readonly string[];
}): DeliveryClass {
  const { state, code, error } = oauthCallbackResultParams(options.search, options.form);
  const hasResult = Boolean(code || error);
  const allowed = options.allowedCallbackPaths ?? [];
  const allowlisted = isAllowlistedOAuthCallbackPath(options.remainingPath, allowed);

  if (allowlisted) {
    if (!hasResult) {
      return "oauth_callback_incomplete";
    }
    if (options.method && !isOAuthCallbackMethod(options.method)) {
      return "oauth_method_not_allowed";
    }
    return "oauth";
  }

  const reserved =
    looksLikeOAuthCallbackPath(options.remainingPath) ||
    Boolean(state?.startsWith(OAUTH_STATE_PREFIX));
  if (reserved) {
    return "oauth_callback_not_registered";
  }

  return "fanout";
}

function oauthCallbackResultParams(
  search: string,
  form: URLSearchParams | null
): { state: string | null; code: string | null; error: string | null } {
  const query = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return {
    state: query.get("state") ?? form?.get("state") ?? null,
    code: query.get("code") ?? form?.get("code") ?? null,
    error: query.get("error") ?? form?.get("error") ?? null
  };
}

/** Read the OAuth `state` query or form field from an inbound request. */
export function readOAuthState(
  search: string,
  form: URLSearchParams | null
): string | null {
  const state = oauthCallbackResultParams(search, form).state;
  return state && state.length > 0 ? state : null;
}

/** Parse `application/x-www-form-urlencoded` bodies; otherwise return null. */
export function parseFormBody(
  contentType: string | null,
  body: ArrayBuffer
): URLSearchParams | null {
  if (!contentType?.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return null;
  }
  return new URLSearchParams(new TextDecoder().decode(body));
}

/** Sign an OAuth state that routes the callback back to this subscriber. */
export async function wrapOAuthState(options: {
  secret: string;
  subscriberId: string;
  routeId: string;
  inner?: string;
  now?: number;
}): Promise<string> {
  if (!options.subscriberId) {
    throw new OAuthStateError("subscriberId is required to wrap OAuth state");
  }
  const payload: SignedOAuthState = {
    v: 1,
    sub: options.subscriberId,
    route: options.routeId,
    exp: (options.now ?? Date.now()) + OAUTH_STATE_TTL_MS
  };
  if (options.inner) {
    payload.d = options.inner;
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = await hmacSha256Base64Url(options.secret, encoded);
  return `${OAUTH_STATE_PREFIX}${encoded}.${mac}`;
}

/** Unwrap a signed OAuth state using the operator secret, then the route secret. */
export async function unwrapOAuthStateForRoute(options: {
  operatorSecret: string;
  routeSecret: string;
  state: string;
  now?: number;
}): Promise<SignedOAuthState | null> {
  const primary = await unwrapOAuthState(options.operatorSecret, options.state, options.now);
  if (primary) {
    return primary;
  }
  return unwrapOAuthState(options.routeSecret, options.state, options.now);
}

/** Verify and decode a `dr1.` signed OAuth state with one HMAC secret. */
export async function unwrapOAuthState(
  secret: string,
  state: string,
  now = Date.now()
): Promise<SignedOAuthState | null> {
  if (!state.startsWith(OAUTH_STATE_PREFIX)) {
    return null;
  }
  const rest = state.slice(OAUTH_STATE_PREFIX.length);
  const split = rest.lastIndexOf(".");
  if (split <= 0) {
    return null;
  }
  const encoded = rest.slice(0, split);
  const mac = rest.slice(split + 1);
  const expected = await hmacSha256Base64Url(secret, encoded);
  if (!timingSafeEqualString(mac, expected)) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as SignedOAuthState;
    if (payload.v !== 1 || typeof payload.sub !== "string" || typeof payload.exp !== "number") {
      return null;
    }
    if (payload.exp < now) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
