/** Constant-time string compare so auth tokens are not leaked through timing. */
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
