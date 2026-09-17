import { describe, expect, it } from "vitest";
import { isScannerProbePath } from "../../src/scanner-probe";

describe("scanner probe paths", () => {
  it("drops credential dumps, PHP leftovers, and debug endpoints", () => {
    const probes = [
      "/firebase-key.json",
      "/firebase-adminsdk.json",
      "/keyfile.json",
      "/key.json",
      "/application_default_credentials.json",
      "/.config/gcloud/application_default_credentials.json",
      "/google-key.json",
      "/google-credentials.json",
      "/credentials.json",
      "/gcp-sa.json",
      "/gcp-credentials.json",
      "/gcp-key.json",
      "/sa.json",
      "/service-account.json",
      "/phpinfo.php.save",
      "/phpinfo.php~",
      "/webroot/index.php/_environment",
      "/_environment",
      "/_profiler/phpinfo",
      "/server-status.php",
      "/server-info.php",
      "/phpversion.php",
      "/php-info.php",
      "/debug.php",
      "/p.php",
      "/phpinfo",
      "/test.php",
      "/pinfo.php",
      "/pi.php",
      "/i.php",
      "/php.php",
      "/info.php",
      "/.env",
      "/.git/config",
      "/wp-admin/install.php",
      "/vendor/phpunit/phpunit"
    ];
    for (const path of probes) {
      expect(isScannerProbePath(path), path).toBe(true);
    }
  });

  it("does not drop webhook, OAuth, or .well-known paths", () => {
    const allowed = [
      "/",
      "/info",
      "/oauth/callback",
      "/auth/callback",
      "/api/hooks/payment",
      "/nomads/api/webhooks/stripe",
      "/vendor/webhooks",
      "/.well-known/openid-configuration",
      "/.well-known/acme-challenge/token"
    ];
    for (const path of allowed) {
      expect(isScannerProbePath(path), path).toBe(false);
    }
  });
});
