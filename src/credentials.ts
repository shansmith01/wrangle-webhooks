import { timingSafeEqualString } from "./auth";

const ROUTE_SECRET_PREFIX = "rt_";
const CONNECTION_TOKEN_PREFIX = "ct_";

export async function deriveRouteSecret(
  operatorSecret: string,
  routeId: string
): Promise<string> {
  const mac = await hmacSha256(operatorSecret, `dev-router:route:${routeId}`);
  return `${ROUTE_SECRET_PREFIX}${mac}`;
}

export function randomConnectionToken(): string {
  return `${CONNECTION_TOKEN_PREFIX}${randomHex(18)}`;
}

export async function hashConnectionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest).toString("hex");
}

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

async function hmacSha256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Buffer.from(signature).toString("base64url");
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
