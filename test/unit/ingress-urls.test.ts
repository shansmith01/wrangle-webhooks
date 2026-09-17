import { expect, test } from "vitest";
import {
  joinTargetUrl,
  publicPathHasDotDotSegment,
  remainingPathFromPublicUrl
} from "../../src/ingress-urls";

test("publicPathHasDotDotSegment rejects path-traversal remaining paths after decode", () => {
  expect(publicPathHasDotDotSegment("/oauth/callback")).toBe(false);
  expect(publicPathHasDotDotSegment("/api/auth/callback/google")).toBe(false);
  expect(publicPathHasDotDotSegment("/oauth/callback/..../admin")).toBe(false);
  expect(publicPathHasDotDotSegment("/api/auth/callback/../../admin")).toBe(true);
  expect(publicPathHasDotDotSegment("/oauth/callback/%2e%2e/admin")).toBe(true);
  expect(publicPathHasDotDotSegment("/api/auth/callback/%252e%252e/admin")).toBe(true);
  expect(publicPathHasDotDotSegment("/oauth/callback/..%2fadmin")).toBe(true);
  expect(publicPathHasDotDotSegment("/oauth/callback/..;/admin")).toBe(true);
  expect(publicPathHasDotDotSegment("/oauth/callback/..\\admin")).toBe(true);
});

test("remainingPathFromPublicUrl strips a named route prefix", () => {
  expect(remainingPathFromPublicUrl("/nomads/oauth/callback", "nomads")).toBe("/oauth/callback");
  expect(remainingPathFromPublicUrl("/oauth/callback", "")).toBe("/oauth/callback");
});

test("joinTargetUrl appends remaining path onto the local origin", () => {
  expect(joinTargetUrl("http://127.0.0.1:3000", "/oauth/callback", "?code=1")).toBe(
    "http://127.0.0.1:3000/oauth/callback?code=1"
  );
});
