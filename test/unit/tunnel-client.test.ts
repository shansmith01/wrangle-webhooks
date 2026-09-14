import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
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
