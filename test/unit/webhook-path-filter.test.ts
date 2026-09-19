import { expect, test } from "vitest";
import {
  remainingPathMatchesWebhookPrefix,
  selectWebhookFanoutSubscribers,
  type WebhookFanoutRule,
  type WebhookFanoutSubscriber
} from "../../src/webhook-path-filter";

test("AC-05 remainingPathMatchesWebhookPrefix uses a path-segment boundary", () => {
  expect(remainingPathMatchesWebhookPrefix("/webhooks/mews", "/webhooks/mews")).toBe(true);
  expect(remainingPathMatchesWebhookPrefix("/webhooks/mews/x", "/webhooks/mews")).toBe(true);
  expect(remainingPathMatchesWebhookPrefix("/webhooks/mews-backup", "/webhooks/mews")).toBe(
    false
  );
  expect(remainingPathMatchesWebhookPrefix("/webhooks/mew", "/webhooks/mews")).toBe(false);
  expect(remainingPathMatchesWebhookPrefix("/webhooks/mews", "/webhooks")).toBe(true);
  expect(remainingPathMatchesWebhookPrefix("/webhook", "/webhooks")).toBe(false);
});

test("AC-06 remainingPathMatchesWebhookPrefix normalizes trailing slash and ignores query", () => {
  expect(remainingPathMatchesWebhookPrefix("/webhooks/mews/", "/webhooks/mews")).toBe(true);
  expect(remainingPathMatchesWebhookPrefix("/webhooks/mews?x=1", "/webhooks/mews")).toBe(true);
  expect(remainingPathMatchesWebhookPrefix("/webhooks/mews", "/webhooks/mews/")).toBe(true);
});

const envA: WebhookFanoutSubscriber = {
  id: "sub_a",
  environmentId: "env-a",
  acceptWebhooks: true
};
const envB: WebhookFanoutSubscriber = {
  id: "sub_b",
  environmentId: "env-b",
  acceptWebhooks: true
};

function rule(
  mode: "allow" | "deny",
  remainingPath: string,
  environmentId: string | null = null
): WebhookFanoutRule {
  return {
    routeId: "nomads",
    mode,
    remainingPath,
    environmentId,
    createdAt: 1
  };
}

test("AC-10 allow then deny: allow /webhooks minus deny /webhooks/stripe", () => {
  const settings = {
    denyAllWebhooks: false,
    rules: [rule("allow", "/webhooks"), rule("deny", "/webhooks/stripe")]
  };
  expect(
    selectWebhookFanoutSubscribers([envA], "/webhooks/mews", settings).map((item) => item.id)
  ).toEqual(["sub_a"]);
  expect(selectWebhookFanoutSubscribers([envA], "/webhooks/stripe", settings)).toEqual([]);
  expect(selectWebhookFanoutSubscribers([envA], "/api/other", settings)).toEqual([]);
});

test("AC-21 route deny-all or subscriber opt-out skips delivery", () => {
  const open = { denyAllWebhooks: false, rules: [] as WebhookFanoutRule[] };
  const muted = { denyAllWebhooks: true, rules: [] as WebhookFanoutRule[] };
  const optedOut: WebhookFanoutSubscriber = {
    ...envA,
    acceptWebhooks: false
  };
  expect(selectWebhookFanoutSubscribers([envA], "/webhooks/mews", open)).toEqual([envA]);
  expect(selectWebhookFanoutSubscribers([envA], "/webhooks/mews", muted)).toEqual([]);
  expect(selectWebhookFanoutSubscribers([optedOut], "/webhooks/mews", open)).toEqual([]);
  expect(selectWebhookFanoutSubscribers([optedOut], "/webhooks/mews", muted)).toEqual([]);
});

test("scoped allow is opt-in for that environment only", () => {
  const settings = {
    denyAllWebhooks: false,
    rules: [rule("allow", "/webhooks/mews", "env-a")]
  };
  expect(
    selectWebhookFanoutSubscribers([envA, envB], "/webhooks/mews", settings).map(
      (item) => item.id
    )
  ).toEqual(["sub_a", "sub_b"]);
  expect(
    selectWebhookFanoutSubscribers([envA, envB], "/webhooks/stripe", settings).map(
      (item) => item.id
    )
  ).toEqual(["sub_b"]);
});
