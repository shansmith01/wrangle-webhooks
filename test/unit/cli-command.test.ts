import { expect, test } from "vitest";
import { resolveCliCommand } from "../../src/cli-command";

test("resolveCliCommand defaults to connect and ignores a redundant npx binary name", () => {
  expect(resolveCliCommand([])).toBe("connect");
  expect(resolveCliCommand(["connect"])).toBe("connect");
  expect(resolveCliCommand(["token"])).toBe("token");
  expect(resolveCliCommand(["dev-router", "connect"])).toBe("connect");
  expect(resolveCliCommand(["dev-router"])).toBe("connect");
});
