export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export function timingSafeEqualString(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength, 1);
  const leftPadded = new Uint8Array(length);
  const rightPadded = new Uint8Array(length);
  leftPadded.set(leftBytes);
  rightPadded.set(rightBytes);
  const bytesEqual = crypto.subtle.timingSafeEqual(leftPadded, rightPadded);
  return bytesEqual && leftBytes.byteLength === rightBytes.byteLength;
}

export function requireManagementAuth(request: Request, secret: string): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return false;
  }
  return timingSafeEqualString(header.slice(prefix.length), secret);
}
