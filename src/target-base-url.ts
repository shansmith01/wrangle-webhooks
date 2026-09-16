/** Invalid public https:// origin the Worker should fetch. */
export class TargetBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetBaseUrlError";
  }
}

/** Normalize and reject a public target base URL that is not https without credentials. */
export function validateTargetBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TargetBaseUrlError("targetBaseUrl must be an absolute URL");
  }

  if (url.protocol !== "https:") {
    throw new TargetBaseUrlError("targetBaseUrl must use https://");
  }
  if (url.username || url.password) {
    throw new TargetBaseUrlError("targetBaseUrl must not contain credentials");
  }
  if (url.hash) {
    throw new TargetBaseUrlError("targetBaseUrl must not contain a fragment");
  }

  return url.toString();
}
