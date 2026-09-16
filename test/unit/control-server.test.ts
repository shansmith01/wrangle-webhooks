import { afterEach, expect, test } from "vitest";
import { startControlServer } from "../../src/control-server";
import type { Connection } from "../../src/dev-router-types";

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
    connected: true,
    connectionState: "connected",
    async whenReady() {
      return;
    },
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

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await server?.close();
  }
});

test("control server exposes readiness and binds OAuth state on the current connection", async () => {
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
    connected: true,
    connectionState: "connected",
    whenReady: async () => undefined,
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
    connected: true,
    reason: "connected",
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

test("control server rejects a non-loopback bind", async () => {
  await expect(
    startControlServer(fakeConnection(), { host: "0.0.0.0", port: 0 })
  ).rejects.toThrow(/loopback/);
});

test("control server requires the control token when configured", async () => {
  const server = await startControlServer(fakeConnection(), { port: 0, token: "s3cret" });
  servers.push(server);
  const denied = await fetch(`${server.url}/ready`);
  expect(denied.status).toBe(401);
  const allowed = await fetch(`${server.url}/ready`, {
    headers: { Authorization: "Bearer s3cret" }
  });
  expect(allowed.status).toBe(200);
});

test("GET /ready returns 503 until the live connection is up, even if a subscriber id is parked", async () => {
  const connection = fakeConnection();
  (connection as { connected: boolean; connectionState: string }).connected = false;
  (connection as { connectionState: string }).connectionState = "connecting";
  const server = await startControlServer(connection, { port: 0 });
  servers.push(server);

  const down = await fetch(`${server.url}/ready`);
  expect(down.status).toBe(503);
  expect(await down.json()).toMatchObject({
    ready: false,
    connected: false,
    reason: "connecting",
    subscriberId: "sub_abc"
  });

  (connection as { connected: boolean }).connected = true;
  (connection as { connectionState: string }).connectionState = "connected";
  const up = await fetch(`${server.url}/ready`);
  expect(up.status).toBe(200);
  expect(await up.json()).toMatchObject({ ready: true, connected: true, reason: "connected" });
});

test("GET /ready reports a safe unauthorized reason while the control port is already open", async () => {
  const connection = fakeConnection();
  (connection as { connected: boolean }).connected = false;
  (connection as { connectionState: string }).connectionState = "unauthorized";
  const server = await startControlServer(connection, { port: 0 });
  servers.push(server);

  const denied = await fetch(`${server.url}/ready`);
  expect(denied.status).toBe(503);
  expect(await denied.json()).toMatchObject({
    ready: false,
    connected: false,
    reason: "unauthorized",
    subscriberId: "sub_abc"
  });
});
