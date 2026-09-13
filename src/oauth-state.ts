export const OAUTH_STATE_PREFIX = "dr1.";
export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
export const OAUTH_STATE_MAX_LENGTH = 2_048;

export interface SignedOAuthState {
  v: 1;
  sub: string;
  route: string;
  exp: number;
  d?: string;
}

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthStateError";
  }
}

export function classifyDelivery(options: {
  remainingPath: string;
  search: string;
  form: URLSearchParams | null;
}): "oauth" | "fanout" {
  const query = new URLSearchParams(
    options.search.startsWith("?") ? options.search.slice(1) : options.search
  );
  const state = query.get("state") ?? options.form?.get("state");
  const code = query.get("code") ?? options.form?.get("code");
  const error = query.get("error") ?? options.form?.get("error");
  if (state && (code || error)) {
    return "oauth";
  }

  const path = options.remainingPath.replace(/\/+$/, "") || "/";
  if (/\/(oauth|auth)\/callback$/i.test(path) || /^\/(oauth|auth)\/callback$/i.test(path)) {
    return "oauth";
  }
  return "fanout";
}

export function readOAuthState(
  search: string,
  form: URLSearchParams | null
): string | null {
  const query = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const state = query.get("state") ?? form?.get("state");
  return state && state.length > 0 ? state : null;
}

export function parseFormBody(
  contentType: string | null,
  body: ArrayBuffer
): URLSearchParams | null {
  if (!contentType?.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return null;
  }
  return new URLSearchParams(new TextDecoder().decode(body));
}

export async function wrapOAuthState(options: {
  secret: string;
  subscriberId: string;
  routeId: string;
  inner?: string;
  now?: number;
}): Promise<string> {
  if (!options.subscriberId) {
    throw new OAuthStateError("subscriberId is required to wrap OAuth state");
  }
  const payload: SignedOAuthState = {
    v: 1,
    sub: options.subscriberId,
    route: options.routeId,
    exp: (options.now ?? Date.now()) + OAUTH_STATE_TTL_MS
  };
  if (options.inner) {
    payload.d = options.inner;
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = await hmacSha256Base64Url(options.secret, encoded);
  return `${OAUTH_STATE_PREFIX}${encoded}.${mac}`;
}

export async function unwrapOAuthState(
  secret: string,
  state: string,
  now = Date.now()
): Promise<SignedOAuthState | null> {
  if (!state.startsWith(OAUTH_STATE_PREFIX)) {
    return null;
  }
  const rest = state.slice(OAUTH_STATE_PREFIX.length);
  const split = rest.lastIndexOf(".");
  if (split <= 0) {
    return null;
  }
  const encoded = rest.slice(0, split);
  const mac = rest.slice(split + 1);
  const expected = await hmacSha256Base64Url(secret, encoded);
  if (!timingSafeEqualUtf8(mac, expected)) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as SignedOAuthState;
    if (payload.v !== 1 || typeof payload.sub !== "string" || typeof payload.exp !== "number") {
      return null;
    }
    if (payload.exp < now) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
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

function timingSafeEqualUtf8(left: string, right: string): boolean {
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
