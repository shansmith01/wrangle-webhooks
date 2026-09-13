import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForShutdownSignal } from "../../src/wait-for-shutdown";

describe("waitForShutdownSignal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("holds a referenced timer so the CLI process stays alive", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const waiting = waitForShutdownSignal();
    const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(true);

    process.emit("SIGTERM");
    await waiting;
  });
});
