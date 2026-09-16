import { deriveRouteSecret } from "../../src/credentials";
import { RouteDurableObject } from "../../src/durable-object";
import { OAUTH_STATE_TTL_MS, wrapOAuthState } from "../../src/oauth-state";
import { durableObjectNameForIndex, durableObjectNameForRoute } from "../../src/route-id";
import { ROUTER_HEADER_CONNECTION } from "../../src/router-headers";
import {
  createExecutionContext,
  env,
  fetchMock,
  runInDurableObject,
  waitOnExecutionContext
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(async () => {
  fetchMock.assertNoPendingInterceptors();
  expect(
    await env.ROUTER_INDEX.getByName(durableObjectNameForIndex()).listRoutes()
  ).toEqual([]);
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Authorization", `Bearer ${env.DEV_ROUTER_SECRET}`);
  return headers;
}

async function dashboardHeaders(extra?: HeadersInit): Promise<Headers> {
  const login = await fetchWorker("https://dev-webhooks.example.com/dashboard/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(env.DEV_ROUTER_DASHBOARD_PASSWORD)}`,
    redirect: "manual"
  });
  expect(login.status).toBe(303);
  const setCookie =
    typeof login.headers.getSetCookie === "function"
      ? login.headers.getSetCookie()[0]
      : login.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  expect(setCookie).toContain("Path=/dashboard");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain("Secure");
  const cookie = (setCookie ?? "").split(";", 1)[0];
  const headers = new Headers(extra);
  headers.set("Cookie", cookie);
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

  it("rejects invalid registration payloads", async () => {
    const http = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/invalid-target/subscribers",
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ targetBaseUrl: "http://dev-a.example" })
      }
    );
    expect(http.status).toBe(400);
    expect(await http.json()).toMatchObject({ error: "invalid_target_base_url" });

    const credentials = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/invalid-target/subscribers",
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          targetBaseUrl: "https://user:pass@dev-a.example"
        })
      }
    );
    expect(credentials.status).toBe(400);
    expect(await credentials.json()).toMatchObject({ error: "invalid_target_base_url" });

    const environmentId = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/invalid-target/subscribers",
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          targetBaseUrl: "https://dev-a.example",
          environmentId: "has space"
        })
      }
    );
    expect(environmentId.status).toBe(400);
    expect(await environmentId.json()).toEqual({ error: "invalid_environment_id" });

    const json = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/invalid-json/subscribers",
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: "not-json"
      }
    );
    expect(json.status).toBe(400);
    expect(await json.json()).toEqual({ error: "invalid_json" });
  });

  it("drops a public subscriber after TTL without a heartbeat", async () => {
    const created = await register("ttl-expire", "https://dev-ttl.example");
    fetchMock
      .get("https://dev-ttl.example")
      .intercept({ path: /\/api\/hooks/, method: "POST" })
      .reply(200, "ok");
    const accepted = await fetchWorker(
      "https://dev-webhooks.example.com/ttl-expire/api/hooks",
      { method: "POST", body: "{}" }
    );
    expect(accepted.status).toBe(202);

    const stub = env.ROUTE.getByName(durableObjectNameForRoute("ttl-expire"));
    await runInDurableObject(stub, async (instance: RouteDurableObject, state) => {
      state.storage.sql.exec("UPDATE subscribers SET expires_at = 0");
      await instance.alarm();
    });

    const heartbeat = await fetchWorker(
      `https://dev-webhooks.example.com/_router/routes/ttl-expire/subscribers/${created.subscriberId}/heartbeat`,
      { method: "POST", headers: authHeaders() }
    );
    expect(heartbeat.status).toBe(404);
    expect(await heartbeat.json()).toEqual({ error: "subscriber_not_found" });

    const remaining = await runInDurableObject(stub, async (instance: RouteDurableObject) => {
      return (await instance.getActiveSubscribers()).length;
    });
    expect(remaining).toBe(0);
  });
});

describe("dashboard", () => {
  it("rejects unauthenticated HTML and JSON", async () => {
    const html = await fetchWorker("https://dev-webhooks.example.com/dashboard");
    expect(html.status).toBe(200);
    expect(html.headers.get("www-authenticate")).toBeNull();
    expect(html.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    const page = await html.text();
    expect(page).toContain('action="/dashboard/login"');
    expect(page).toContain('name="password"');
    expect(page).not.toContain('id="routes"');

    const json = await fetchWorker("https://dev-webhooks.example.com/dashboard/status");
    expect(json.status).toBe(401);
    expect(await json.json()).toEqual({ error: "unauthorized" });
  });

  it("does not accept the management bearer token or HTTP Basic", async () => {
    const bearer = await fetchWorker("https://dev-webhooks.example.com/dashboard", {
      headers: authHeaders()
    });
    expect(bearer.status).toBe(200);
    expect(await bearer.text()).toContain('action="/dashboard/login"');

    const basic = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: {
        Authorization: `Basic ${btoa(`:${env.DEV_ROUTER_DASHBOARD_PASSWORD}`)}`
      }
    });
    expect(basic.status).toBe(401);
  });

  it("serves HTML after a password login cookie", async () => {
    const headers = await dashboardHeaders();
    const response = await fetchWorker("https://dev-webhooks.example.com/dashboard", {
      headers
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    const html = await response.text();
    expect(html).toContain('action="/dashboard/logout"');
    expect(html).toContain("/dashboard/status");
    expect(html).toContain('id="routes"');
    expect(html).toContain("Live connections");
    expect(html).toContain("Inbound requests");
    expect(html).toContain('id="inbound"');
    expect(html).toContain("Connection history");
    expect(html).toContain('id="history"');

    const status = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      ok: true,
      routeCount: 0,
      subscriberCount: 0,
      routes: [],
      inboundLog: [],
      connectionLog: []
    });
  });

  it("does not embed subscriber JSON in a script tag", async () => {
    await register(
      "dash-xss",
      "https://evil.example/?x=</script><script>alert(1)",
      "amp-thread-xss"
    );
    const response = await fetchWorker("https://dev-webhooks.example.com/dashboard", {
      headers: await dashboardHeaders()
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    const html = await response.text();
    expect(html).not.toMatch(/const status = /);
    expect(html).not.toContain("</script><script>alert(1)");
  });

  it("lists active subscribers as JSON including environment id", async () => {
    const created = await register(
      "dash-route",
      "https://dev-dash.example",
      "amp-thread-dashboard"
    );
    const response = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
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
    expect(body.routeCount).toBe(1);
    expect(body.subscriberCount).toBe(1);
    expect(body.routes).toHaveLength(1);
    const route = body.routes[0];
    expect(route?.routeId).toBe("dash-route");
    expect(route?.subscribers).toHaveLength(1);
    expect(route?.subscribers[0]?.id).toBe(created.subscriberId);
    expect(route?.subscribers[0]?.transport).toBe("public");
    expect(route?.subscribers[0]?.targetBaseUrl).toBe("https://dev-dash.example/");
    expect(route?.subscribers[0]?.environmentId).toBe("amp-thread-dashboard");
  });

  it("keeps a historical connection audit log after disconnect", async () => {
    const created = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/audit-route/subscribers",
      {
        method: "POST",
        headers: authHeaders({
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.50"
        }),
        body: JSON.stringify({
          targetBaseUrl: "https://dev-audit.example",
          environmentId: "amp-thread-audit"
        })
      }
    );
    expect(created.status).toBe(200);
    const registered = (await created.json()) as {
      subscriberId: string;
      connectionToken: string;
    };
    const connected = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    expect(connected.status).toBe(200);
    const live = (await connected.json()) as {
      connectionLog: Array<{
        action: string;
        reason: string;
        routeId: string;
        subscriberId: string | null;
        environmentId: string | null;
        transport: string | null;
        targetBaseUrl: string | null;
        clientIp: string | null;
      }>;
    };
    expect(live.connectionLog[0]).toMatchObject({
      action: "connected",
      reason: "registered",
      routeId: "audit-route",
      subscriberId: registered.subscriberId,
      environmentId: "amp-thread-audit",
      transport: "public",
      targetBaseUrl: "https://dev-audit.example/",
      clientIp: "203.0.113.50"
    });
    expect(JSON.stringify(live)).not.toContain(registered.connectionToken);
    expect(JSON.stringify(live)).not.toMatch(/"forwardToken"/);

    const removed = await fetchWorker(
      `https://dev-webhooks.example.com/_router/routes/audit-route/subscribers/${registered.subscriberId}`,
      { method: "DELETE", headers: authHeaders() }
    );
    expect(removed.status).toBe(204);

    const history = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const body = (await history.json()) as {
      routeCount: number;
      subscriberCount: number;
      routes: unknown[];
      connectionLog: Array<{ action: string; reason: string; subscriberId: string | null }>;
    };
    expect(body.routeCount).toBe(0);
    expect(body.subscriberCount).toBe(0);
    expect(body.routes).toEqual([]);
    expect(body.connectionLog[0]).toMatchObject({
      action: "disconnected",
      reason: "deregistered",
      subscriberId: registered.subscriberId
    });
    expect(body.connectionLog[1]).toMatchObject({
      action: "connected",
      reason: "registered",
      subscriberId: registered.subscriberId
    });
  });

  it("records unauthorized join attempts with the connecting IP", async () => {
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/audit-denied/subscribers",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "198.51.100.9"
        },
        body: JSON.stringify({ targetBaseUrl: "https://dev-a.example" })
      }
    );
    expect(response.status).toBe(401);

    const status = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const body = (await status.json()) as {
      connectionLog: Array<{
        action: string;
        reason: string;
        routeId: string;
        clientIp: string | null;
        subscriberId: string | null;
      }>;
    };
    expect(body.connectionLog[0]).toMatchObject({
      action: "rejected",
      reason: "unauthorized",
      routeId: "audit-denied",
      clientIp: "198.51.100.9",
      subscriberId: null
    });
  });

  it("redirects /dashboard.json under the cookie path", async () => {
    const response = await fetchWorker("https://dev-webhooks.example.com/dashboard.json", {
      redirect: "manual"
    });
    expect(response.status).toBe(308);
    expect(new URL(response.headers.get("location") ?? "", "https://dev-webhooks.example.com").pathname).toBe(
      "/dashboard/status"
    );
  });

  it("does not forward /dashboard to default subscribers", async () => {
    await register("", "https://dev-root.example");
    const response = await fetchWorker("https://dev-webhooks.example.com/dashboard");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    expect(await response.text()).toContain('action="/dashboard/login"');
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

  it("records unmatched inbound requests without query values", async () => {
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/missing/api/hooks?access_token=SHOULD-NOT-LOG"
    );
    expect(response.status).toBe(404);

    const status = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const body = (await status.json()) as {
      inboundLog: Array<{
        method: string;
        routeId: string | null;
        path: string;
        hasQuery: boolean;
        kind: string;
        result: string;
        status: number;
        error: string | null;
        subscriberCount: number;
      }>;
    };
    expect(body.inboundLog[0]).toMatchObject({
      method: "GET",
      routeId: null,
      path: "/missing/api/hooks",
      hasQuery: true,
      kind: "webhook",
      result: "rejected",
      status: 404,
      error: "route_not_found",
      subscriberCount: 0
    });
    expect(JSON.stringify(body)).not.toContain("SHOULD-NOT-LOG");
  });

  it("accepts a public request and fans out to every subscriber independently", async () => {
    await register("fanout-route", "https://dev-a.example/dev-ingress");
    await register("fanout-route", "https://dev-b.example/dev-ingress");

    let capturedHeaders: Record<string, string | string[]> | undefined;
    fetchMock
      .get("https://dev-a.example")
      .intercept({
        path: (path) => path.includes("/dev-ingress/api/hooks/payment"),
        method: "POST",
        headers: (headers) => {
          capturedHeaders = headers;
          return true;
        }
      })
      .reply(200, "ok");
    fetchMock
      .get("https://dev-b.example")
      .intercept({
        path: (path) => path.includes("/dev-ingress/api/hooks/payment"),
        method: "POST"
      })
      .reply(500, "nope");

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/fanout-route/api/hooks/payment?id=1&id=2",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": "t=1,v1=sig",
          "X-Signature": "goki-hmac",
          Authorization: "Bearer should-not-forward",
          Cookie: "dashboard=should-not-forward",
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
    const authorization =
      headerBag.authorization ?? headerBag.Authorization;
    const cookie = headerBag.cookie ?? headerBag.Cookie;
    expect(authorization).toBeUndefined();
    expect(cookie).toBeUndefined();
    const signature = headerBag["x-signature"] ?? headerBag["X-Signature"];
    expect(signature).toBe("goki-hmac");
    const stripe =
      headerBag["stripe-signature"] ?? headerBag["Stripe-Signature"];
    expect(stripe).toBe("t=1,v1=sig");
  });

  it("records inbound webhook metadata without body, query, or headers", async () => {
    await register("inbound-log", "https://dev-inbound.example");
    fetchMock
      .get("https://dev-inbound.example")
      .intercept({ path: /\/api\/hooks\/payment/, method: "POST" })
      .reply(200, "ok");

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/inbound-log/api/hooks/payment?customer=SHOULD-NOT-LOG",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer SHOULD-NOT-LOG",
          Cookie: "session=SHOULD-NOT-LOG",
          "Stripe-Signature": "t=1,v1=SHOULD-NOT-LOG"
        },
        body: '{"email":"SHOULD-NOT-LOG@example.com","card":"4242"}'
      }
    );
    expect(response.status).toBe(202);

    const status = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const body = (await status.json()) as {
      inboundLog: Array<{
        id: string;
        method: string;
        routeId: string | null;
        path: string;
        hasQuery: boolean;
        kind: string;
        result: string;
        status: number;
        error: string | null;
        subscriberCount: number;
        bodyBytes: number;
      }>;
    };
    expect(body.inboundLog[0]).toMatchObject({
      method: "POST",
      routeId: "inbound-log",
      path: "/api/hooks/payment",
      hasQuery: true,
      kind: "webhook",
      result: "accepted",
      status: 202,
      error: null,
      subscriberCount: 1,
      bodyBytes: '{"email":"SHOULD-NOT-LOG@example.com","card":"4242"}'.length
    });
    expect(body.inboundLog[0]?.id).toMatch(/^req_[a-z0-9]+$/i);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("SHOULD-NOT-LOG");
    expect(serialized).not.toContain("4242");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toMatch(/"forwardToken"/);
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
      .reply(302, "redirect-a", {
        headers: {
          Location: "https://app.example/a",
          "Set-Cookie": "session=abc; Path=/"
        }
      });
    fetchMock
      .get("https://dev-oauth-a.example")
      .intercept({ path: /\/api\/auth\/callback\/google/, method: "GET" })
      .reply(302, "redirect-google", {
        headers: { Location: "https://app.example/google" }
      });

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
    expect(response.headers.get("Set-Cookie")).toBeNull();

    const nested = await fetchWorker(
      "https://dev-webhooks.example.com/oauth-route/api/auth/callback/google?code=one-time&state=orb-a-state"
    );
    expect(nested.status).toBe(302);
    expect(nested.headers.get("Location")).toBe("https://app.example/google");

    const status = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const body = (await status.json()) as {
      inboundLog: Array<{
        kind: string;
        result: string;
        status: number;
        path: string;
        hasQuery: boolean;
        error: string | null;
      }>;
    };
    expect(body.inboundLog[0]).toMatchObject({
      kind: "oauth",
      result: "proxied",
      status: 302,
      path: "/api/auth/callback/google",
      hasQuery: true,
      error: null
    });
    expect(JSON.stringify(body)).not.toContain("one-time");
    expect(JSON.stringify(body)).not.toContain("orb-a-state");
  });

  it("does not fan an uncorrelated OAuth callback to every subscriber", async () => {
    await register("oauth-ambiguous", "https://dev-oauth-a.example");
    await register("oauth-ambiguous", "https://dev-oauth-b.example");

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/oauth-ambiguous/oauth/callback?code=one-time&state=unknown"
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "oauth_unroutable" });

    const status = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const body = (await status.json()) as {
      inboundLog: Array<{
        kind: string;
        result: string;
        status: number;
        error: string | null;
        path: string;
        hasQuery: boolean;
      }>;
    };
    expect(body.inboundLog[0]).toMatchObject({
      kind: "oauth",
      result: "rejected",
      status: 409,
      error: "oauth_unroutable",
      path: "/oauth/callback",
      hasQuery: true
    });
    expect(JSON.stringify(body)).not.toContain("one-time");
  });

  it("does not reverse-proxy arbitrary paths that include OAuth query params", async () => {
    await register("probe-route", "https://dev-probe.example");
    fetchMock
      .get("https://dev-probe.example")
      .intercept({ path: /\/admin/, method: "GET" })
      .reply(200, "internal-ok");

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/probe-route/admin?state=1&code=1"
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
  });

  it("routes a form-encoded OAuth callback and rejects an expired signed state", async () => {
    const first = await register("form-oauth", "https://dev-form-a.example");
    await register("form-oauth", "https://dev-form-b.example");

    fetchMock
      .get("https://dev-form-a.example")
      .intercept({ path: /\/oauth\/callback/, method: "POST" })
      .reply(302, "redirect-a", {
        headers: { Location: "https://app.example/form" }
      });
    fetchMock
      .get("https://dev-form-a.example")
      .intercept({ path: /\/custom\/redirect/, method: "GET" })
      .reply(302, "redirect-signed", {
        headers: { Location: "https://app.example/signed" }
      });

    const bind = await fetchWorker(
      `https://dev-webhooks.example.com/_router/routes/form-oauth/subscribers/${first.subscriberId}/oauth-states`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ state: "form-orb-state" })
      }
    );
    expect(bind.status).toBe(200);

    const routed = await fetchWorker(
      "https://dev-webhooks.example.com/form-oauth/oauth/callback",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: "one-time",
          state: "form-orb-state"
        }).toString()
      }
    );
    expect(routed.status).toBe(302);
    expect(routed.headers.get("Location")).toBe("https://app.example/form");

    const signed = await wrapOAuthState({
      secret: env.DEV_ROUTER_SECRET,
      subscriberId: first.subscriberId,
      routeId: "form-oauth"
    });
    const custom = await fetchWorker(
      `https://dev-webhooks.example.com/form-oauth/custom/redirect?code=abc&state=${encodeURIComponent(signed)}`
    );
    expect(custom.status).toBe(302);
    expect(custom.headers.get("Location")).toBe("https://app.example/signed");

    const expired = await wrapOAuthState({
      secret: env.DEV_ROUTER_SECRET,
      subscriberId: first.subscriberId,
      routeId: "form-oauth",
      now: Date.now() - OAUTH_STATE_TTL_MS - 1
    });
    const rejected = await fetchWorker(
      "https://dev-webhooks.example.com/form-oauth/oauth/callback",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: "late",
          state: expired
        }).toString()
      }
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: "oauth_unroutable" });
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
        headers: [
          ["Location", "https://app.example/landed"],
          ["Set-Cookie", "session=abc; Path=/"]
        ],
        body: ""
      })
    );
    const response = await oauthPromise;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://app.example/landed");
    expect(response.headers.get("Set-Cookie")).toBeNull();
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

  it("accepts a public webhook and fans it out over the reverse tunnel", async () => {
    const { ws, hello } = await openTunnel("orb-hooks");
    const requestMessage = waitForJson(ws);
    const ctx = createExecutionContext();
    const publicPromise = worker.fetch(
      new Request("https://dev-webhooks.example.com/orb-hooks/api/hooks/payment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature": "goki-hmac"
        },
        body: '{"ok":true}'
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx
    );

    const incoming = await requestMessage;
    expect(incoming.type).toBe("request");
    expect(incoming.method).toBe("POST");
    expect(incoming.path).toBe("/api/hooks/payment");
    const headers = incoming.headers as [string, string][];
    expect(headers.some(([name]) => name.toLowerCase() === "x-dev-router-secret")).toBe(
      false
    );
    expect(
      headers.some(
        ([name, value]) =>
          name.toLowerCase() === "x-dev-router-token" && value === hello.forwardToken
      )
    ).toBe(true);
    expect(
      headers.some(
        ([name, value]) => name.toLowerCase() === "x-signature" && value === "goki-hmac"
      )
    ).toBe(true);

    ws.send(
      JSON.stringify({
        type: "response",
        id: incoming.id,
        status: 500,
        headers: [["Content-Type", "text/plain"]],
        body: "nope"
      })
    );
    const response = await publicPromise;
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    await waitOnExecutionContext(ctx);
    ws.close(1000, "done");
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

  it("rejects a second join that tries to steal a live environment id", async () => {
    const first = await openTunnel("env-live", "amp-thread-live");
    const denied = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/env-live/tunnel?environmentId=amp-thread-live",
      { headers: authHeaders({ Upgrade: "websocket" }) }
    );
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "environment_in_use" });
    first.ws.close(1000, "done");
  });

  it("replaces a live tunnel when the connection token matches", async () => {
    const first = await openTunnel("env-token", "amp-thread-token");
    const second = await openTunnel(
      "env-token",
      "amp-thread-token",
      first.hello.connectionToken
    );
    expect(second.hello.subscriberId).toBe(first.hello.subscriberId);
    expect(second.hello.connectionToken).not.toBe(first.hello.connectionToken);
    second.ws.close(1000, "done");
  });

  it("rejects public re-register of a live environment id without the connection token", async () => {
    await register("env-public", "https://dev-env-a.example", "amp-thread-public");
    const path = "https://dev-webhooks.example.com/_router/routes/env-public/subscribers";
    const denied = await fetchWorker(path, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        targetBaseUrl: "https://dev-env-b.example",
        environmentId: "amp-thread-public"
      })
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "environment_in_use" });

    const status = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const body = (await status.json()) as {
      connectionLog: Array<{ action: string; reason: string; environmentId: string | null }>;
    };
    expect(body.connectionLog[0]).toMatchObject({
      action: "rejected",
      reason: "environment_in_use",
      environmentId: "amp-thread-public"
    });
  });
});

async function openTunnel(
  routeId: string,
  environmentId?: string,
  connectionToken?: string
): Promise<{
  ws: WebSocket;
  hello: { subscriberId: string; forwardToken: string; connectionToken: string; environmentId?: string };
}> {
  const ctx = createExecutionContext();
  const path = environmentId
    ? `https://dev-webhooks.example.com/_router/routes/${routeId}/tunnel?environmentId=${encodeURIComponent(environmentId)}`
    : `https://dev-webhooks.example.com/_router/routes/${routeId}/tunnel`;
  const headers = authHeaders({ Upgrade: "websocket" });
  if (connectionToken) {
    headers.set(ROUTER_HEADER_CONNECTION, connectionToken);
  }
  const response = await worker.fetch(
    new Request(path, {
      headers
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
