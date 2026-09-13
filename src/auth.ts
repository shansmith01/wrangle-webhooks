import { decodeTunnelSubprotocolSecret } from "./tunnel-protocol";

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
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
