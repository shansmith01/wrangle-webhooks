import { decodeTunnelSubprotocolSecret } from "./tunnel-protocol";

export const DASHBOARD_COOKIE_NAME = "dev_router_dashboard";
export const DASHBOARD_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export function unauthorizedDashboard(): Response {
  return Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "Cache-Control": "no-store" } }
  );
}

export async function requireDashboardAuth(
  request: Request,
  password: string
): Promise<boolean> {
  if (!password) {
    return false;
  }
  const session = readDashboardSession(request);
  if (!session) {
    return false;
  }
  return verifyDashboardSession(session, password);
}

export async function mintDashboardSession(
  password: string,
  now = Date.now()
): Promise<string> {
  const exp = now + DASHBOARD_SESSION_TTL_MS;
  const mac = await hmacSha256Base64Url(password, dashboardSessionPayload(exp));
  return `${exp}.${mac}`;
}

export async function verifyDashboardSession(
  session: string,
  password: string,
  now = Date.now()
): Promise<boolean> {
  const split = session.lastIndexOf(".");
  if (split <= 0) {
    return false;
  }
  const expRaw = session.slice(0, split);
  const mac = session.slice(split + 1);
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || exp < now) {
    return false;
  }
  const expected = await hmacSha256Base64Url(password, dashboardSessionPayload(exp));
  return timingSafeEqualString(mac, expected);
}

export function dashboardSessionSetCookie(request: Request, session: string): string {
  return serializeDashboardCookie(request, session, DASHBOARD_SESSION_TTL_MS / 1000);
}

export function dashboardSessionClearCookie(request: Request): string {
  return serializeDashboardCookie(request, "", 0);
}

export function timingSafeEqualString(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength, 1);
  let mismatch = leftBytes.byteLength === rightBytes.byteLength ? 0 : 1;
  for (let i = 0; i < length; i++) {
    mismatch |= (leftBytes[i] ?? 0) ^ (rightBytes[i] ?? 0);
  }
  return mismatch === 0;
}

export function requireManagementAuth(request: Request, secret: string): boolean {
  const bearer = readManagementSecret(request);
  return bearer !== null && timingSafeEqualString(bearer, secret);
}

export function readManagementSecret(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (header.startsWith(prefix) && header.length > prefix.length) {
    return header.slice(prefix.length);
  }
  return decodeTunnelSubprotocolSecret(request.headers.get("Sec-WebSocket-Protocol"));
}

function readDashboardSession(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    if (trimmed.slice(0, eq) === DASHBOARD_COOKIE_NAME) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}

function serializeDashboardCookie(request: Request, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${DASHBOARD_COOKIE_NAME}=${value}; Path=/dashboard; Max-Age=${Math.trunc(maxAge)}; HttpOnly; SameSite=Strict${secure}`;
}

function dashboardSessionPayload(exp: number): string {
  return `dev-router:dashboard:${exp}`;
}

async function hmacSha256Base64Url(secret: string, data: string): Promise<string> {
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
