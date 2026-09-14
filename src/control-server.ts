import { unlink } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Connection } from "./types";

export const CONTROL_DEFAULT_PORT = 8790;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface ControlServerOptions {
  host?: string;
  port?: number;
  socketPath?: string;
  token?: string;
}

export interface ControlServer {
  url: string;
  close(): Promise<void>;
}

export async function startControlServer(
  connection: Connection,
  options: ControlServerOptions = {}
): Promise<ControlServer> {
  const token = options.token;
  const socketPath = options.socketPath;
  const host = options.host ?? "127.0.0.1";
  if (!socketPath && !LOOPBACK_HOSTS.has(host)) {
    throw new Error("control server must listen on loopback");
  }

  const server = http.createServer((req, res) => {
    void handleControlRequest(req, res, connection, token);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    if (socketPath) {
      server.listen(socketPath, () => {
        server.off("error", onError);
        resolve();
      });
      return;
    }
    server.listen(options.port ?? CONTROL_DEFAULT_PORT, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const url = socketPath ? socketUrl(socketPath) : tcpUrl(server, host);

  return {
    url,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      if (socketPath) {
        await unlink(socketPath).catch(() => undefined);
      }
    }
  };
}

async function handleControlRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  connection: Connection,
  token: string | undefined
): Promise<void> {
  try {
    if (token && !controlTokenMatches(req, token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const path = urlPath(req.url);
    if ((req.method === "GET" || req.method === "HEAD") && (path === "/ready" || path === "/status")) {
      const ready = connection.connected;
      const body = {
        ok: true,
        ready,
        connected: ready,
        subscriberId: connection.subscriberId,
        routeId: connection.routeId,
        publicUrl: connection.publicUrl,
        transport: connection.transport,
        environmentId: connection.environmentId ?? null
      };
      if (req.method === "HEAD") {
        res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
        res.end();
        return;
      }
      sendJson(res, ready ? 200 : 503, body);
      return;
    }

    if (req.method === "POST" && path === "/oauth-states") {
      const payload = await readJson(req);
      const state =
        payload && typeof payload === "object" && "state" in payload && typeof payload.state === "string"
          ? payload.state
          : "";
      if (!state) {
        sendJson(res, 400, { error: "invalid_oauth_state" });
        return;
      }
      await connection.bindOAuthState(state);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && path === "/oauth-wrap") {
      const payload = await readJson(req);
      const inner =
        payload && typeof payload === "object" && "inner" in payload && typeof payload.inner === "string"
          ? payload.inner
          : undefined;
      const state = await connection.wrapOAuthState(inner);
      sendJson(res, 200, { state });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "control_request_failed";
    sendJson(res, 500, { error: "control_request_failed", message });
  }
}

function controlTokenMatches(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const prefix = "Bearer ";
  if (header.startsWith(prefix)) {
    return header.slice(prefix.length) === token;
  }
  const headerToken = req.headers["x-dev-router-control-token"];
  const value = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  return value === token;
}

function urlPath(url: string | undefined): string {
  if (!url) {
    return "/";
  }
  const parsed = new URL(url, "http://127.0.0.1");
  return parsed.pathname;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 16_384) {
        req.destroy();
        reject(new Error("request_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": payload.byteLength
  });
  res.end(payload);
}

function tcpUrl(server: http.Server, host: string): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("control server failed to bind");
  }
  const bound = address as AddressInfo;
  const hostname = host === "::1" ? "[::1]" : host;
  return `http://${hostname}:${bound.port}`;
}

function socketUrl(socketPath: string): string {
  return `unix:${socketPath}`;
}
