import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startControlServer } from "../../src/control-server";
import { TunnelConnection } from "../../src/tunnel-client";
import type { TunnelRequestMessage } from "../../src/tunnel-protocol";

type ForwardLocal = {
  forwardLocal(message: TunnelRequestMessage): Promise<{
    type: "response";
    id: string;
    status: number;
    headers: [string, string][];
    body?: string;
  }>;
};

describe("TunnelConnection.forwardLocal", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("sends the localUrl host when the public Host header differs", async () => {
    let receivedHost: string | undefined;
    let receivedForwardedHost: string | undefined;
    const server = http.createServer((req, res) => {
      receivedHost = req.headers.host;
      receivedForwardedHost = req.headers["x-forwarded-host"] as string | undefined;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    servers.push(server);
    const port = await listen(server);
    const localHost = `127.0.0.1:${port}`;
    const publicHost = "dev-webhooks.example.com";

    const connection = new TunnelConnection({
      routerUrl: "https://dev-webhooks.example.com",
      secret: "test-secret",
      routeId: "nomads",
      localUrl: `http://${localHost}`
    });

    const response = await (connection as unknown as ForwardLocal).forwardLocal({
      type: "request",
      id: "req_host",
      method: "GET",
      path: "/health",
      search: "",
      headers: [
        ["Host", publicHost],
        ["X-Forwarded-Host", publicHost]
      ]
    });

    expect(response.status).toBe(200);
    expect(receivedHost).toBe(localHost);
    expect(receivedForwardedHost).toBe(publicHost);
  });
});

describe("TunnelConnection control surface while connecting", () => {
  const servers: http.Server[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      await close?.();
    }
    while (servers.length > 0) {
      const server = servers.pop();
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("serves GET /ready with unauthorized when the WebSocket upgrade is 401", async () => {
    const denied = http.createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    });
    servers.push(denied);
    const port = await listen(denied);

    const connection = new TunnelConnection({
      routerUrl: `http://127.0.0.1:${port}`,
      secret: "wrong-secret",
      routeId: "",
      localUrl: "http://127.0.0.1:3000"
    });
    connection.begin();
    const control = await startControlServer(connection, { port: 0 });
    closers.push(async () => {
      await control.close();
      await connection.disconnect();
    });

    const connecting = await fetch(`${control.url}/ready`);
    expect(connecting.status).toBe(503);
    expect(await connecting.json()).toMatchObject({
      ready: false,
      connected: false
    });

    await expect.poll(() => connection.connectionState).toBe("unauthorized");
    const ready = await fetch(`${control.url}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      ready: false,
      connected: false,
      reason: "unauthorized"
    });
  });
});

function listen(server: http.Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, host, () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
