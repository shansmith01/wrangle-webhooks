import { describe, expect, it } from "vitest";
import { resolveCliCommand } from "../../src/cli-command";

describe("resolveCliCommand", () => {
  it("defaults to connect", () => {
    expect(resolveCliCommand([])).toBe("connect");
  });

  it("accepts connect and token", () => {
    expect(resolveCliCommand(["connect"])).toBe("connect");
    expect(resolveCliCommand(["token"])).toBe("token");
  });

  it("ignores a redundant binary name from npx github installs", () => {
    expect(resolveCliCommand(["dev-router", "connect"])).toBe("connect");
    expect(resolveCliCommand(["dev-router"])).toBe("connect");
  });
});
