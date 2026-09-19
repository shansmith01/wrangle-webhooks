import { expect, test } from "vitest";
import {
  envDisablesWebhookFanout,
  parseAcceptWebhooksValue,
  resolveAcceptWebhooks
} from "../../src/accept-webhooks";

test("AC-20 envDisablesWebhookFanout accepts 1, true, and yes", () => {
  expect(envDisablesWebhookFanout(undefined)).toBe(false);
  expect(envDisablesWebhookFanout("")).toBe(false);
  expect(envDisablesWebhookFanout("0")).toBe(false);
  expect(envDisablesWebhookFanout("no")).toBe(false);
  expect(envDisablesWebhookFanout("1")).toBe(true);
  expect(envDisablesWebhookFanout("true")).toBe(true);
  expect(envDisablesWebhookFanout("YES")).toBe(true);
});

test("AC-20 parseAcceptWebhooksValue defaults to accept", () => {
  expect(parseAcceptWebhooksValue(undefined)).toBe(true);
  expect(parseAcceptWebhooksValue(null)).toBe(true);
  expect(parseAcceptWebhooksValue(true)).toBe(true);
  expect(parseAcceptWebhooksValue("1")).toBe(true);
  expect(parseAcceptWebhooksValue(false)).toBe(false);
  expect(parseAcceptWebhooksValue(0)).toBe(false);
  expect(parseAcceptWebhooksValue("0")).toBe(false);
  expect(parseAcceptWebhooksValue("false")).toBe(false);
});

test("AC-20 resolveAcceptWebhooks honors --no-webhooks and DEV_ROUTER_NO_WEBHOOKS", () => {
  expect(resolveAcceptWebhooks({})).toBe(true);
  expect(resolveAcceptWebhooks({ flag: true })).toBe(false);
  expect(resolveAcceptWebhooks({ envValue: "true" })).toBe(false);
  expect(resolveAcceptWebhooks({ acceptWebhooks: false })).toBe(false);
  expect(resolveAcceptWebhooks({ flag: false, envValue: "nope" })).toBe(true);
});
