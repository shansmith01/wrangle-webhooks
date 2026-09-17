/** Filenames internet-wide scanners request looking for leaked cloud keys. */
const SCANNER_CREDENTIAL_FILENAMES = new Set([
  "application_default_credentials.json",
  "credentials.json",
  "firebase-adminsdk.json",
  "firebase-key.json",
  "gcp-credentials.json",
  "gcp-key.json",
  "gcp-sa.json",
  "google-credentials.json",
  "google-key.json",
  "id_rsa",
  "key.json",
  "keyfile.json",
  "sa.json",
  "service-account.json"
]);

/** Last-path-segment debug dumps that are not webhook or OAuth callbacks. */
const SCANNER_DEBUG_SEGMENTS = new Set([
  "_environment",
  "php-info",
  "phpinfo",
  "phpversion",
  "server-info",
  "server-status"
]);

/** True when the public path is a credential, PHP, or debug scanner probe. */
export function isScannerProbePath(pathname: string): boolean {
  const path = normalizeScannerPath(pathname);
  if (path === "/") {
    return false;
  }
  if (hasBlockedScriptExtension(path)) {
    return true;
  }
  const segments = path.split("/").filter(Boolean);
  const first = segments[0] ?? "";
  const last = segments[segments.length - 1] ?? "";
  if (first.startsWith(".") && first !== ".well-known") {
    return true;
  }
  if (SCANNER_CREDENTIAL_FILENAMES.has(last) || SCANNER_DEBUG_SEGMENTS.has(last)) {
    return true;
  }
  if (first === "_profiler" || first === "wp-admin" || first === "wp-content") {
    return true;
  }
  if (path.includes("/vendor/phpunit")) {
    return true;
  }
  return false;
}

function normalizeScannerPath(pathname: string): string {
  const withoutQuery = pathname.split("?")[0]?.split("#")[0] ?? "/";
  let decoded = withoutQuery;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    decoded = withoutQuery;
  }
  const path = decoded.toLowerCase();
  return path.startsWith("/") ? path : `/${path}`;
}

/** `.php`, `.php.save`, `/index.php/_environment`, and other script leftovers. */
function hasBlockedScriptExtension(path: string): boolean {
  return /\.(?:php\d*|phtml|asp|aspx|jsp|cgi)(?:$|[./~_-])/i.test(path);
}
