import { expect, test } from "vitest";
import { managementTunnelPath } from "../../src/tunnel-protocol";

test("AC-17 managementTunnelPath adds acceptWebhooks=0 when this subscriber denies webhooks", () => {
  expect(managementTunnelPath("nomads", "orb-1")).toBe(
    "/_router/routes/nomads/tunnel?environmentId=orb-1"
  );
  expect(managementTunnelPath("nomads", "orb-1", false)).toBe(
    "/_router/routes/nomads/tunnel?environmentId=orb-1&acceptWebhooks=0"
  );
  expect(managementTunnelPath("", undefined, false)).toBe("/_router/tunnel?acceptWebhooks=0");
  expect(managementTunnelPath("")).toBe("/_router/tunnel");
});
