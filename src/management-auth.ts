import { decodeTunnelSubprotocolSecret } from "./tunnel-protocol";
import { timingSafeEqualString } from "./timing-safe-equal";

/** JSON 401 for a missing or invalid management bearer token. */
export function unauthorizedManagementResponse(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/** True when Authorization or the tunnel subprotocol carries the operator secret. */
export function requireManagementAuth(request: Request, secret: string): boolean {
  const bearer = readManagementSecret(request);
  return bearer !== null && timingSafeEqualString(bearer, secret);
}

/** Read the operator or route secret from Bearer auth or the tunnel subprotocol. */
export function readManagementSecret(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (header.startsWith(prefix) && header.length > prefix.length) {
    return header.slice(prefix.length);
  }
  return decodeTunnelSubprotocolSecret(request.headers.get("Sec-WebSocket-Protocol"));
}
