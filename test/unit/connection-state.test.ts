import { describe, expect, it } from "vitest";
import {
  classifyConnectionFailure,
  nextConnectionFailure
} from "../../src/connection-state";

describe("classifyConnectionFailure", () => {
  it("treats HTTP 401/403 and unauthorized messages as unauthorized", () => {
    expect(classifyConnectionFailure(undefined, 401)).toBe("unauthorized");
    expect(classifyConnectionFailure(undefined, 403)).toBe("unauthorized");
    expect(classifyConnectionFailure(new Error("Unexpected server response: 401"))).toBe(
      "unauthorized"
    );
    expect(classifyConnectionFailure(new Error("unauthorized"))).toBe("unauthorized");
  });

  it("treats other failures as network_error without echoing details", () => {
    expect(classifyConnectionFailure(new Error("connect ECONNREFUSED"))).toBe("network_error");
    expect(classifyConnectionFailure(undefined, 502)).toBe("network_error");
  });
});

describe("nextConnectionFailure", () => {
  it("does not let a later network error hide unauthorized", () => {
    expect(
      nextConnectionFailure("unauthorized", new Error("tunnel closed before open"))
    ).toBe("unauthorized");
  });

  it("keeps disconnected sticky", () => {
    expect(nextConnectionFailure("disconnected", undefined, 401)).toBe("disconnected");
  });
});
