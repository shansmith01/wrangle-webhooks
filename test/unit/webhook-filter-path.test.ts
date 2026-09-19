import { expect, test } from "vitest";
import {
  normalizeWebhookFilterPath,
  parseWebhookFilterEnvironmentId,
  validateWebhookFanoutRuleMode,
  validateWebhookFilterPath
} from "../../src/webhook-filter-path";

test("AC-07 validateWebhookFilterPath accepts remaining path prefixes and rejects illegal rules", () => {
  expect(validateWebhookFilterPath("/webhooks/mews")).toBe("/webhooks/mews");
  expect(validateWebhookFilterPath("/webhooks/mews/")).toBe("/webhooks/mews");
  expect(validateWebhookFilterPath("")).toBeNull();
  expect(validateWebhookFilterPath("/")).toBeNull();
  expect(validateWebhookFilterPath("http://evil")).toBeNull();
  expect(validateWebhookFilterPath("//x")).toBeNull();
  expect(validateWebhookFilterPath("/a?b")).toBeNull();
  expect(validateWebhookFilterPath("/a#b")).toBeNull();
  expect(validateWebhookFilterPath("/a*")).toBeNull();
  expect(validateWebhookFilterPath("/foo/../bar")).toBeNull();
  expect(validateWebhookFilterPath("/phpinfo.php")).toBeNull();
  expect(validateWebhookFilterPath("/credentials.json")).toBeNull();
});

test("normalizeWebhookFilterPath strips trailing slashes and query/hash", () => {
  expect(normalizeWebhookFilterPath("/webhooks/mews/")).toBe("/webhooks/mews");
  expect(normalizeWebhookFilterPath("/webhooks/mews?x=1")).toBe("/webhooks/mews");
  expect(normalizeWebhookFilterPath("webhooks/mews")).toBe("/webhooks/mews");
});

test("validateWebhookFanoutRuleMode accepts only allow or deny", () => {
  expect(validateWebhookFanoutRuleMode("allow")).toBe("allow");
  expect(validateWebhookFanoutRuleMode("deny")).toBe("deny");
  expect(validateWebhookFanoutRuleMode("skip")).toBeNull();
  expect(validateWebhookFanoutRuleMode("only")).toBeNull();
});

test("parseWebhookFilterEnvironmentId treats empty as all subscribers", () => {
  expect(parseWebhookFilterEnvironmentId(undefined)).toEqual({
    ok: true,
    environmentId: null
  });
  expect(parseWebhookFilterEnvironmentId("")).toEqual({ ok: true, environmentId: null });
  expect(parseWebhookFilterEnvironmentId("env-a")).toEqual({
    ok: true,
    environmentId: "env-a"
  });
  expect(parseWebhookFilterEnvironmentId("has space")).toEqual({ ok: false });
});
