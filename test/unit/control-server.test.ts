import { afterEach, describe, expect, it } from "vitest";
import { startControlServer } from "../../src/control-server";
import type { Connection } from "../../src/types";

function fakeConnection(): Connection {
  return {
    subscriberId: "sub_abc",
    routeId: "nomads",
    targetBaseUrl: "http://127.0.0.1:3000",
    publicUrl: "https://dev-webhooks.example.com/nomads/*",
    transport: "tunnel",
    forwardToken: "ft_test",
    connectionToken: "ct_test",
    environmentId: "amp-thread-1",
    async disconnect() {
      return;
    },
    async wrapOAuthState(inner?: string) {
      return `wrapped:${inner ?? ""}`;
    },
    async bindOAuthState() {
      return;
    }
  };
}

describe("sidecar control server", () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      await server?.close();
    }
  });

  it("exposes readiness and binds OAuth state on the current connection", async () => {
    const binds: string[] = [];
    const connection: Connection = {
      subscriberId: "sub_abc",
      routeId: "nomads",
      targetBaseUrl: "http://127.0.0.1:3000/",
      publicUrl: "https://dev-webhooks.example.com/nomads/*",
      transport: "tunnel",
      forwardToken: "ft_test",
      connectionToken: "ct_test",
      environmentId: "amp-thread-1",
      disconnect: async () => undefined,
      wrapOAuthState: async (inner) => `wrapped:${inner ?? ""}`,
      bindOAuthState: async (state) => {
        binds.push(state);
      }
    };
    const server = await startControlServer(connection, { port: 0 });
    servers.push(server);

    const ready = await fetch(`${server.url}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ok: true,
      ready: true,
      subscriberId: "sub_abc",
      routeId: "nomads",
      environmentId: "amp-thread-1"
    });

    const bind = await fetch(`${server.url}/oauth-states`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "orb-a-state" })
    });
    expect(bind.status).toBe(200);
    expect(binds).toEqual(["orb-a-state"]);

    const wrapped = await fetch(`${server.url}/oauth-wrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inner: "nonce" })
    });
    expect(await wrapped.json()).toEqual({ state: "wrapped:nonce" });
  });

  it("rejects a non-loopback bind", async () => {
    await expect(
      startControlServer(fakeConnection(), { host: "0.0.0.0", port: 0 })
    ).rejects.toThrow(/loopback/);
  });

  it("requires the control token when configured", async () => {
    const server = await startControlServer(fakeConnection(), { port: 0, token: "s3cret" });
    servers.push(server);
    const denied = await fetch(`${server.url}/ready`);
    expect(denied.status).toBe(401);
    const allowed = await fetch(`${server.url}/ready`, {
      headers: { Authorization: "Bearer s3cret" }
    });
    expect(allowed.status).toBe(200);
  });
});
