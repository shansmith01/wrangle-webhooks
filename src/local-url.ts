/** Invalid local HTTP origin for reverse-tunnel mode. */
export class LocalUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalUrlError";
  }
}

/** Normalize and reject a local URL that is not an absolute http(s) origin. */
export function validateLocalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalUrlError("localUrl must be an absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LocalUrlError("localUrl must use http:// or https://");
  }
  if (url.username || url.password) {
    throw new LocalUrlError("localUrl must not contain credentials");
  }
  if (url.hash) {
    throw new LocalUrlError("localUrl must not contain a fragment");
  }

  return url.toString();
}
