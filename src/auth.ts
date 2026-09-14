import { decodeTunnelSubprotocolSecret } from "./tunnel-protocol";

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export function unauthorizedDashboard(json: boolean): Response {
  const headers = {
    "WWW-Authenticate": 'Basic realm="Dev router dashboard"',
    "Cache-Control": "no-store"
  };
  if (json) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers });
  }
  return new Response("Unauthorized", { status: 401, headers });
}

export function readBasicAuthPassword(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Basic ";
  if (!header.startsWith(prefix) || header.length <= prefix.length) {
    return null;
  }
  try {
    const decoded = atob(header.slice(prefix.length).trim());
    const colon = decoded.indexOf(":");
    if (colon === -1) {
      return null;
    }
    return decoded.slice(colon + 1);
  } catch {
    return null;
  }
}

export function requireDashboardAuth(request: Request, password: string): boolean {
  if (!password) {
    return false;
  }
  const provided = readBasicAuthPassword(request);
  return provided !== null && timingSafeEqualString(provided, password);
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
