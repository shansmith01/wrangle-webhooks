/** Cryptographically random hex string of `byteLength` bytes (twice as many hex chars). */
export function randomHex(byteLength: number): string {
  const arr = new Uint8Array(byteLength);
  crypto.getRandomValues(arr);
  return [...arr].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
