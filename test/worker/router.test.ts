import { deriveRouteSecret } from "../../src/credentials";
import {
  createExecutionContext,
  env,
  fetchMock,
  waitOnExecutionContext
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Authorization", `Bearer ${env.DEV_ROUTER_SECRET}`);
  return headers;
}

function dashboardHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set(
    "Authorization",
    `Basic ${btoa(`:${env.DEV_ROUTER_DASHBOARD_PASSWORD}`)}`
  );
  return headers;
}

async function fetchWorker(
  input: string,
  init?: RequestInit
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(input, init) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function register(
  routeId: string,
  targetBaseUrl: string,
  environmentId?: string
): Promise<{ subscriberId: string; connectionToken: string }> {
  const path =
    routeId === ""
      ? "https://dev-webhooks.example.com/_router/subscribers"
      : `https://dev-webhooks.example.com/_router/routes/${routeId}/subscribers`;
  const response = await fetchWorker(path, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ targetBaseUrl, ...(environmentId ? { environmentId } : {}) })
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { subscriberId: string; connectionToken: string };
}

describe("management API", () => {
  it("rejects unauthenticated registration", async () => {
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/project-a/subscribers",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetBaseUrl: "https://dev-a.example" })
      }
    );
    expect(response.status).toBe(401);
  });

  it("registers, heartbeats, and deregisters a subscriber", async () => {
    const created = await register("lifecycle-route", "https://dev-a.example");
    expect(created.subscriberId).toMatch(/^sub_[0-9a-f]+$/);
    expect(created.connectionToken).toMatch(/^ct_/);

    const heartbeat = await fetchWorker(
      `https://dev-webhooks.example.com/_router/routes/lifecycle-route/subscribers/${created.subscriberId}/heartbeat`,
      { method: "POST", headers: authHeaders() }
    );
    expect(heartbeat.status).toBe(200);

    const removed = await fetchWorker(
      `https://dev-webhooks.example.com/_router/routes/lifecycle-route/subscribers/${created.subscriberId}`,
      { method: "DELETE", headers: authHeaders() }
    );
    expect(removed.status).toBe(204);
  });

  it("rejects http target URLs", async () => {
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/invalid-target/subscribers",
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ targetBaseUrl: "http://dev-a.example" })
      }
    );
    expect(response.status).toBe(400);
  });
});

describe("dashboard", () => {
  it("rejects unauthenticated HTML and JSON", async () => {
    const html = await fetchWorker("https://dev-webhooks.example.com/dashboard");
    expect(html.status).toBe(401);
    expect(html.headers.get("www-authenticate")).toMatch(/Basic/i);

    const json = await fetchWorker("https://dev-webhooks.example.com/dashboard.json");
    expect(json.status).toBe(401);
    expect(await json.json()).toEqual({ error: "unauthorized" });
  });

  it("does not accept the management bearer token", async () => {
    const response = await fetchWorker("https://dev-webhooks.example.com/dashboard", {
      headers: authHeaders()
    });
    expect(response.status).toBe(401);
  });

  it("serves HTML with the dashboard password", async () => {
    const response = await fetchWorker("https://dev-webhooks.example.com/dashboard", {
      headers: dashboardHeaders()
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    const html = await response.text();
    expect(html).toContain("Dev router");
    expect(html).toContain("No active connections.");
    expect(html).toContain("Environment id");
  });

  it("lists active subscribers as JSON including environment id", async () => {
    const created = await register(
      "dash-route",
      "https://dev-dash.example",
      "amp-thread-dashboard"
    );
    const response = await fetchWorker("https://dev-webhooks.example.com/dashboard.json", {
      headers: dashboardHeaders()
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      secretConfigured: boolean;
      routeCount: number;
      subscriberCount: number;
      routes: Array<{
        routeId: string;
        subscribers: Array<{
          id: string;
          targetBaseUrl: string;
          transport: string;
          environmentId: string | null;
        }>;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.secretConfigured).toBe(true);
    expect(body.routeCount).toBeGreaterThanOrEqual(1);
    expect(body.subscriberCount).toBeGreaterThanOrEqual(1);
    const route = body.routes.find((item) => item.routeId === "dash-route");
    expect(route?.subscribers[0]?.id).toBe(created.subscriberId);
    expect(route?.subscribers[0]?.transport).toBe("public");
    expect(route?.subscribers[0]?.targetBaseUrl).toBe("https://dev-dash.example/");
    expect(route?.subscribers[0]?.environmentId).toBe("amp-thread-dashboard");
  });

  it("does not forward /dashboard to default subscribers", async () => {
    await register("", "https://dev-root.example");
    const response = await fetchWorker("https://dev-webhooks.example.com/dashboard", {
      headers: dashboardHeaders()
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
  });
});

describe("public routing", () => {
  it("returns 404 when a route has no active subscribers", async () => {
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/missing/api/hooks"
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "route_not_found" });
  });

  it("accepts a public request and fans out to every subscriber independently", async () => {
    await register("fanout-route", "https://dev-a.example");
    await register("fanout-route", "https://dev-b.example");

    let capturedHeaders: Record<string, string | string[]> | undefined;
    fetchMock
      .get("https://dev-a.example")
      .intercept({
        path: /\/api\/hooks\/payment/,
        method: "POST",
        headers: (headers) => {
          capturedHeaders = headers;
          return true;
        }
      })
      .reply(200, "ok");
    fetchMock
      .get("https://dev-b.example")
      .intercept({ path: /\/api\/hooks\/payment/, method: "POST" })
      .reply(500, "nope");

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/fanout-route/api/hooks/payment?id=123",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": "t=1,v1=sig",
          "CF-Connecting-IP": "203.0.113.10"
        },
        body: '{"ok":true}'
      }
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(capturedHeaders).toBeDefined();
    const headerBag = capturedHeaders ?? {};
    const secretHeader =
      headerBag["x-dev-router-secret"] ?? headerBag["X-Dev-Router-Secret"];
    expect(secretHeader).toBeUndefined();
    const tokenHeader =
      headerBag["x-dev-router-token"] ?? headerBag["X-Dev-Router-Token"];
    expect(tokenHeader).toBeTruthy();
  });

  it("does not forward the reserved management namespace", async () => {
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/_router/unknown",
      { headers: authHeaders() }
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("forwards the full path when the route id is empty", async () => {
    await register("", "https://dev-root.example");

    fetchMock
      .get("https://dev-root.example")
      .intercept({ path: /\/oauth\/callback/, method: "GET" })
      .reply(200, "ok");

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/oauth/callback?code=123"
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("returns the subscriber redirect for a correlated OAuth callback", async () => {
    const first = await register("oauth-route", "https://dev-oauth-a.example");
    await register("oauth-route", "https://dev-oauth-b.example");

    fetchMock
      .get("https://dev-oauth-a.example")
      .intercept({ path: /\/oauth\/callback/, method: "GET" })
      .reply(302, "redirect-a", { headers: { Location: "https://app.example/a" } });

    const bind = await fetchWorker(
      `https://dev-webhooks.example.com/_router/routes/oauth-route/subscribers/${first.subscriberId}/oauth-states`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ state: "orb-a-state" })
      }
    );
    expect(bind.status).toBe(200);

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/oauth-route/oauth/callback?code=one-time&state=orb-a-state"
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://app.example/a");
  });

  it("does not fan an uncorrelated OAuth callback to every subscriber", async () => {
    await register("oauth-ambiguous", "https://dev-oauth-a.example");
    await register("oauth-ambiguous", "https://dev-oauth-b.example");

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/oauth-ambiguous/oauth/callback?code=one-time&state=unknown"
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "oauth_unroutable" });
  });
});

describe("reverse tunnel", () => {
  it("rejects unauthenticated tunnel upgrades", async () => {
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/orb/tunnel",
      { headers: { Upgrade: "websocket" } }
    );
    expect(response.status).toBe(401);
  });

  it("multiplexes HTTP over a subscriber WebSocket and returns OAuth responses", async () => {
    const { ws, hello } = await openTunnel("orb");
    expect(hello.subscriberId).toMatch(/^sub_/);
    expect(hello.forwardToken).toMatch(/^ft_/);
    expect(hello.connectionToken).toMatch(/^ct_/);

    const requestMessage = waitForJson(ws);
    const ctx = createExecutionContext();
    const oauthPromise = worker.fetch(
      new Request(
        "https://dev-webhooks.example.com/orb/oauth/callback?code=abc&state=xyz"
      ) as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx
    );
    const incoming = await requestMessage;
    expect(incoming.type).toBe("request");
    expect(incoming.method).toBe("GET");
    expect(incoming.path).toBe("/oauth/callback");
    const headers = incoming.headers as [string, string][];
    expect(headers.some(([name]) => name.toLowerCase() === "x-dev-router-secret")).toBe(
      false
    );
    expect(headers.some(([name, value]) => name.toLowerCase() === "x-dev-router-token" && value === hello.forwardToken)).toBe(
      true
    );

    ws.send(
      JSON.stringify({
        type: "response",
        id: incoming.id,
        status: 302,
        headers: [["Location", "https://app.example/landed"]],
        body: ""
      })
    );
    const response = await oauthPromise;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://app.example/landed");
    await waitOnExecutionContext(ctx);
    ws.close(1000, "done");
  });

  it("removes a tunneled subscriber as soon as the socket closes", async () => {
    const { ws } = await openTunnel("orb-close");
    await new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve(), { once: true });
      ws.close(1000, "client disconnect");
    });

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/orb-close/api/hooks"
    );
    expect(response.status).toBe(404);
  });
});

describe("scoped credentials", () => {
  it("lets a route credential join only that route", async () => {
    const routeSecret = await deriveRouteSecret(env.DEV_ROUTER_SECRET, "nomads");
    const allowed = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/nomads/subscribers",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${routeSecret}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ targetBaseUrl: "https://dev-nomads.example" })
      }
    );
    expect(allowed.status).toBe(200);

    const denied = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/other/subscribers",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${routeSecret}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ targetBaseUrl: "https://dev-other.example" })
      }
    );
    expect(denied.status).toBe(401);
  });

  it("does not let a route credential bind or delete another subscriber", async () => {
    const created = await register("scoped-bind", "https://dev-a.example");
    const routeSecret = await deriveRouteSecret(env.DEV_ROUTER_SECRET, "scoped-bind");
    const bind = await fetchWorker(
      `https://dev-webhooks.example.com/_router/routes/scoped-bind/subscribers/${created.subscriberId}/oauth-states`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${routeSecret}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ state: "stolen" })
      }
    );
    expect(bind.status).toBe(401);

    const allowed = await fetchWorker(
      `https://dev-webhooks.example.com/_router/routes/scoped-bind/subscribers/${created.subscriberId}/oauth-states`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${created.connectionToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ state: "orb-a-state" })
      }
    );
    expect(allowed.status).toBe(200);
  });

  it("mints a route credential only for the operator secret", async () => {
    const minted = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/nomads/credential",
      { headers: authHeaders() }
    );
    expect(minted.status).toBe(200);
    const body = (await minted.json()) as { secret: string };
    expect(body.secret).toBe(await deriveRouteSecret(env.DEV_ROUTER_SECRET, "nomads"));

    const denied = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/nomads/credential",
      { headers: { Authorization: `Bearer ${body.secret}` } }
    );
    expect(denied.status).toBe(401);
  });

  it("mints a root-scoped credential for the empty route", async () => {
    const minted = await fetchWorker("https://dev-webhooks.example.com/_router/credential", {
      headers: authHeaders()
    });
    expect(minted.status).toBe(200);
    const body = (await minted.json()) as { routeId: string; secret: string };
    expect(body.routeId).toBe("");
    expect(body.secret).toBe(await deriveRouteSecret(env.DEV_ROUTER_SECRET, ""));
  });
});

describe("stable environment identity", () => {
  it("reuses a subscriber id and OAuth bindings across tunnel reconnects", async () => {
    const first = await openTunnel("env-route", "amp-thread-9");
    expect(first.hello.environmentId).toBe("amp-thread-9");

    const bind = await fetchWorker(
      `https://dev-webhooks.example.com/_router/routes/env-route/subscribers/${first.hello.subscriberId}/oauth-states`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ state: "pending-oauth" })
      }
    );
    expect(bind.status).toBe(200);

    await new Promise<void>((resolve) => {
      first.ws.addEventListener("close", () => resolve(), { once: true });
      first.ws.close(1000, "reconnect");
    });

    const second = await openTunnel("env-route", "amp-thread-9");
    expect(second.hello.subscriberId).toBe(first.hello.subscriberId);

    const requestMessage = waitForJson(second.ws);
    const ctx = createExecutionContext();
    const oauthPromise = worker.fetch(
      new Request(
        "https://dev-webhooks.example.com/env-route/oauth/callback?code=abc&state=pending-oauth"
      ) as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx
    );
    const incoming = await requestMessage;
    second.ws.send(
      JSON.stringify({
        type: "response",
        id: incoming.id,
        status: 302,
        headers: [["Location", "https://app.example/landed"]],
        body: ""
      })
    );
    const response = await oauthPromise;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://app.example/landed");
    await waitOnExecutionContext(ctx);
    second.ws.close(1000, "done");
  });
});

async function openTunnel(
  routeId: string,
  environmentId?: string
): Promise<{
  ws: WebSocket;
  hello: { subscriberId: string; forwardToken: string; connectionToken: string; environmentId?: string };
}> {
  const ctx = createExecutionContext();
  const path = environmentId
    ? `https://dev-webhooks.example.com/_router/routes/${routeId}/tunnel?environmentId=${encodeURIComponent(environmentId)}`
    : `https://dev-webhooks.example.com/_router/routes/${routeId}/tunnel`;
  const response = await worker.fetch(
    new Request(path, {
      headers: authHeaders({ Upgrade: "websocket" })
    }) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx
  );
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  expect(ws).toBeDefined();
  ws!.accept();
  const hello = await waitForJson(ws!);
  expect(hello.type).toBe("hello");
  await waitOnExecutionContext(ctx);
  return {
    ws: ws as WebSocket,
    hello: hello as {
      subscriberId: string;
      forwardToken: string;
      connectionToken: string;
      environmentId?: string;
    }
  };
}

function waitForJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      const text = String(event.data);
      if (text === "ping" || text === "pong") {
        return;
      }
      try {
        ws.removeEventListener("message", onMessage);
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener(
      "error",
      () => {
        reject(new Error("websocket error"));
      },
      { once: true }
    );
  });
}
