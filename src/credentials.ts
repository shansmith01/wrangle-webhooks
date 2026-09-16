import { hmacSha256Base64Url } from "./hmac-sha256";
import { randomHex } from "./random-hex";
import { timingSafeEqualString } from "./timing-safe-equal";

const ROUTE_SECRET_PREFIX = "rt_";
const CONNECTION_TOKEN_PREFIX = "ct_";

/** Derive a route-scoped secret (`rt_…`) from the operator secret. */
export async function deriveRouteSecret(
  operatorSecret: string,
  routeId: string
): Promise<string> {
  const mac = await hmacSha256Base64Url(operatorSecret, `dev-router:route:${routeId}`);
  return `${ROUTE_SECRET_PREFIX}${mac}`;
}

/** Fresh connection token (`ct_…`) proving control of a subscriber slot. */
export function randomConnectionToken(): string {
  return `${CONNECTION_TOKEN_PREFIX}${randomHex(18)}`;
}

/** SHA-256 hex digest of a connection token for Durable Object storage. */
export async function hashConnectionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest).toString("hex");
}

/** Timing-safe compare of a presented connection token against a stored hash. */
export async function connectionTokenMatches(
  token: string,
  expectedHash: string
): Promise<boolean> {
  if (!expectedHash) {
    return false;
  }
  const actual = await hashConnectionToken(token);
  return timingSafeEqualString(actual, expectedHash);
}

/** Classify a presented secret as operator, route-scoped, or neither. */
export async function matchJoinCredential(
  secret: string | null,
  operatorSecret: string,
  routeId: string
): Promise<"operator" | "route" | null> {
  if (!secret) {
    return null;
  }
  if (timingSafeEqualString(secret, operatorSecret)) {
    return "operator";
  }
  const routeSecret = await deriveRouteSecret(operatorSecret, routeId);
  if (timingSafeEqualString(secret, routeSecret)) {
    return "route";
  }
  return null;
}
