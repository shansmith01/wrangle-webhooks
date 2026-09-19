import { expect, test } from "vitest";
import {
  isAllowlistedOAuthCallbackPath,
  looksLikeOAuthCallbackPath,
  normalizeOAuthCallbackPath,
  validateOAuthCallbackPath
} from "../../src/oauth-callback-path";

test("normalizeOAuthCallbackPath strips trailing slashes and query/hash", () => {
  expect(normalizeOAuthCallbackPath("/oauth/callback/")).toBe("/oauth/callback");
  expect(normalizeOAuthCallbackPath("/api/auth/callback/google")).toBe(
    "/api/auth/callback/google"
  );
  expect(normalizeOAuthCallbackPath("oauth/callback")).toBe("/oauth/callback");
});

test("validateOAuthCallbackPath accepts remaining paths and rejects hosts, globs, and probes", () => {
  expect(validateOAuthCallbackPath("/oauth/callback")).toBe("/oauth/callback");
  expect(validateOAuthCallbackPath("/api/auth/callback/google")).toBe(
    "/api/auth/callback/google"
  );
  expect(validateOAuthCallbackPath("/api/integrations/oolio/callback")).toBe(
    "/api/integrations/oolio/callback"
  );
  expect(validateOAuthCallbackPath("https://evil.example/oauth/callback")).toBeNull();
  expect(validateOAuthCallbackPath("/oauth/callback?code=1")).toBeNull();
  expect(validateOAuthCallbackPath("/oauth/*/callback")).toBeNull();
  expect(validateOAuthCallbackPath("/oauth/callback/../admin")).toBeNull();
  expect(validateOAuthCallbackPath("/phpinfo.php")).toBeNull();
  expect(validateOAuthCallbackPath("")).toBeNull();
});

test("looksLikeOAuthCallbackPath matches oauth and auth only (not oolio)", () => {
  expect(looksLikeOAuthCallbackPath("/oauth/callback")).toBe(true);
  expect(looksLikeOAuthCallbackPath("/api/auth/callback/google")).toBe(true);
  expect(looksLikeOAuthCallbackPath("/oolio/callback")).toBe(false);
  expect(looksLikeOAuthCallbackPath("/api/integrations/oolio/callback")).toBe(false);
  expect(looksLikeOAuthCallbackPath("/api/hooks")).toBe(false);
});

test("isAllowlistedOAuthCallbackPath requires an exact normalized match", () => {
  expect(isAllowlistedOAuthCallbackPath("/oauth/callback", ["/oauth/callback"])).toBe(true);
  expect(isAllowlistedOAuthCallbackPath("/oauth/callback/", ["/oauth/callback"])).toBe(true);
  expect(isAllowlistedOAuthCallbackPath("/oauth/callback", [])).toBe(false);
  expect(
    isAllowlistedOAuthCallbackPath("/api/auth/callback/google", ["/oauth/callback"])
  ).toBe(false);
});
