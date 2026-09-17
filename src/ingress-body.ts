import { TUNNEL_MAX_BODY_BYTES } from "./tunnel-protocol";

/** Read a public ingress body, rejecting payloads above the 768 KiB tunnel cap. */
export async function readCappedIngressBody(
  request: Request,
  maxBytes = TUNNEL_MAX_BODY_BYTES
): Promise<
  { ok: true; body: ArrayBuffer } | { ok: false; error: "request_too_large"; bodyBytes: number }
> {
  const declared = declaredIngressContentLength(request);
  if (declared !== null && declared > maxBytes) {
    return { ok: false, error: "request_too_large", bodyBytes: declared };
  }

  const stream = request.body;
  if (!stream) {
    return { ok: true, body: new ArrayBuffer(0) };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { ok: false, error: "request_too_large", bodyBytes: size };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: bytes.buffer };
}

/** Content-Length of a public ingress request, or null when missing or invalid. */
export function declaredIngressContentLength(request: Request): number | null {
  const header = request.headers.get("Content-Length");
  if (!header || !/^\d{1,12}$/.test(header.trim())) {
    return null;
  }
  return Number(header.trim());
}
