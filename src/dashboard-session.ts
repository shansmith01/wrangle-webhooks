import { hmacSha256Base64Url } from "./hmac-sha256";
import { timingSafeEqualString } from "./timing-safe-equal";

/** Cookie name for the signed dashboard session. */
export const DASHBOARD_COOKIE_NAME = "dev_router_dashboard";

/** Dashboard session lifetime in milliseconds (seven days). */
export const DASHBOARD_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** JSON 401 for a missing or invalid dashboard session. */
export function unauthorizedDashboard(): Response {
  return Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "Cache-Control": "no-store" } }
  );
}

/** True when the request carries a valid signed dashboard session cookie. */
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

/** Mint a signed dashboard session cookie value from the dashboard password. */
export async function mintDashboardSession(
  password: string,
  now = Date.now()
): Promise<string> {
  const exp = now + DASHBOARD_SESSION_TTL_MS;
  const mac = await hmacSha256Base64Url(password, dashboardSessionPayload(exp));
  return `${exp}.${mac}`;
}

/** Verify a signed dashboard session against the dashboard password. */
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

/** Set-Cookie header that stores a dashboard session on `/dashboard`. */
export function dashboardSessionSetCookie(request: Request, session: string): string {
  return serializeDashboardCookie(request, session, DASHBOARD_SESSION_TTL_MS / 1000);
}

/** Set-Cookie header that clears the dashboard session cookie. */
export function dashboardSessionClearCookie(request: Request): string {
  return serializeDashboardCookie(request, "", 0);
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
