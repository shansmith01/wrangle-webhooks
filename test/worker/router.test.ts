import { deriveRouteSecret } from "../../src/credentials";
import { RouteDurableObject } from "../../src/durable-object";
import { OAUTH_STATE_TTL_MS, wrapOAuthState } from "../../src/oauth-state";
import { durableObjectNameForIndex, durableObjectNameForRoute } from "../../src/route-id";
import { ROUTER_HEADER_CONNECTION } from "../../src/router-headers";
import { TUNNEL_MAX_BODY_BYTES } from "../../src/tunnel-protocol";
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
  const index = env.ROUTER_INDEX.getByName(durableObjectNameForIndex());
  expect(await index.listRoutes()).toEqual([]);
  const paths = await index.listAllOAuthCallbackPaths();
  for (const row of paths) {
    await index.removeOAuthCallbackPath(row.routeId, row.remainingPath);
  }
  expect(await index.listAllOAuthCallbackPaths()).toEqual([]);
  await index.clearWebhookFanout();
  expect(await index.listAllWebhookFanoutRules()).toEqual([]);
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
  environmentId?: string,
  acceptWebhooks = true
): Promise<{ subscriberId: string; connectionToken: string }> {
  const path =
    routeId === ""
      ? "https://dev-webhooks.example.com/_router/subscribers"
      : `https://dev-webhooks.example.com/_router/routes/${routeId}/subscribers`;
  const response = await fetchWorker(path, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      targetBaseUrl,
      ...(environmentId ? { environmentId } : {}),
      ...(acceptWebhooks ? {} : { acceptWebhooks: false })
    })
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { subscriberId: string; connectionToken: string };
}

function webhookFanoutUrl(routeId: string, rules = false): string {
  const suffix = rules ? "webhook-fanout-rules" : "webhook-fanout";
  return routeId === ""
    ? `https://dev-webhooks.example.com/_router/${suffix}`
    : `https://dev-webhooks.example.com/_router/routes/${routeId}/${suffix}`;
}

async function putWebhookFanout(routeId: string, denyAllWebhooks: boolean): Promise<void> {
  const response = await fetchWorker(webhookFanoutUrl(routeId), {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ denyAllWebhooks })
  });
  expect(response.status).toBe(200);
}

async function putWebhookFanoutRule(
  routeId: string,
  rule: { mode: "allow" | "deny"; path: string; environmentId?: string }
): Promise<void> {
  const response = await fetchWorker(webhookFanoutUrl(routeId, true), {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(rule)
  });
  expect(response.status).toBe(200);
}

/** Register an exact remaining path for OAuth reverse proxy (operator secret only). */
async function registerOAuthCallbackPath(
  routeId: string,
  remainingPath: string
): Promise<void> {
  const path =
    routeId === ""
      ? "https://dev-webhooks.example.com/_router/oauth-callback-paths"
      : `https://dev-webhooks.example.com/_router/routes/${routeId}/oauth-callback-paths`;
  const response = await fetchWorker(path, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ path: remainingPath })
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    routeId,
    path: remainingPath
  });
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
    expect(html).toContain("OAuth callback paths");
    expect(html).toContain('id="oauth-callbacks"');
    expect(html).toContain("No OAuth callback paths registered");
    expect(html).toContain("Webhook fan-out");
    expect(html).toContain('id="webhook-fanout"');
    expect(html).toContain("Deny all webhook fan-out");
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
      oauthCallbackPaths: [],
      webhookFanout: { settings: [], rules: [] },
      inboundLog: [],
      connectionLog: []
    });
  });

  it("registers OAuth callback paths from the dashboard form", async () => {
    const headers = await dashboardHeaders({
      "Content-Type": "application/x-www-form-urlencoded"
    });
    const created = await fetchWorker(
      "https://dev-webhooks.example.com/dashboard/oauth-callback-paths",
      {
        method: "POST",
        headers,
        body: "routeId=dash-oauth&path=%2Fapi%2Fauth%2Fcallback%2Fgoogle",
        redirect: "manual"
      }
    );
    expect(created.status).toBe(303);

    const status = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const body = (await status.json()) as {
      oauthCallbackPaths: Array<{ routeId: string; remainingPath: string }>;
    };
    expect(body.oauthCallbackPaths).toEqual([
      { routeId: "dash-oauth", remainingPath: "/api/auth/callback/google", createdAt: expect.any(Number) }
    ]);

    const removed = await fetchWorker(
      "https://dev-webhooks.example.com/dashboard/oauth-callback-paths/delete",
      {
        method: "POST",
        headers: await dashboardHeaders({
          "Content-Type": "application/x-www-form-urlencoded"
        }),
        body: "routeId=dash-oauth&path=%2Fapi%2Fauth%2Fcallback%2Fgoogle",
        redirect: "manual"
      }
    );
    expect(removed.status).toBe(303);
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
          acceptWebhooks: boolean;
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
    expect(route?.subscribers[0]?.acceptWebhooks).toBe(true);
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
  it("records unmatched GET / without treating it as a scanner probe", async () => {
    const response = await fetchWorker("https://dev-webhooks.example.com/");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "route_not_found" });

    const status = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const body = (await status.json()) as {
      inboundLog: Array<{ path: string; error: string | null }>;
    };
    expect(body.inboundLog[0]).toMatchObject({
      path: "/",
      error: "route_not_found"
    });
  });

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

  it("drops scanner probes without forwarding or recording inbound metadata", async () => {
    await register("", "https://dev-root.example");
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/phpinfo.php"
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "route_not_found" });

    const credential = await fetchWorker(
      "https://dev-webhooks.example.com/credentials.json"
    );
    expect(credential.status).toBe(404);

    const status = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const body = (await status.json()) as {
      inboundLog: Array<{ path: string }>;
    };
    expect(body.inboundLog.map((event) => event.path)).not.toContain("/phpinfo.php");
    expect(body.inboundLog.map((event) => event.path)).not.toContain("/credentials.json");
    expect(await env.ROUTER_INDEX.getByName(durableObjectNameForIndex()).listRoutes()).toEqual([
      ""
    ]);
  });

  it("drops remaining paths with a decoded dot-dot segment without forwarding", async () => {
    await register("", "https://dev-root.example");
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/oauth/callback/%252e%252e/admin?code=1"
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "route_not_found" });

    const status = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const body = (await status.json()) as {
      inboundLog: Array<{ path: string }>;
    };
    expect(body.inboundLog.map((event) => event.path)).not.toContain(
      "/oauth/callback/%252e%252e/admin"
    );
  });

  it("still fans out real root webhooks after scanner probes are dropped", async () => {
    await register("", "https://dev-root.example");
    fetchMock
      .get("https://dev-root.example")
      .intercept({ path: "/api/hooks/payment", method: "POST" })
      .reply(200, "ok");

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/api/hooks/payment",
      { method: "POST", body: "{\"ok\":true}" }
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
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
          "X-Original-URL": "/admin",
          "X-Real-IP": "1.2.3.4",
          "X-Forwarded-For": "1.2.3.4, 5.6.7.8",
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
    const originalUrl = headerBag["x-original-url"] ?? headerBag["X-Original-URL"];
    const realIp = headerBag["x-real-ip"] ?? headerBag["X-Real-IP"];
    expect(originalUrl).toBeUndefined();
    expect(realIp).toBeUndefined();
    const forwardedFor = headerBag["x-forwarded-for"] ?? headerBag["X-Forwarded-For"];
    expect(forwardedFor).toBe("203.0.113.10");
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
      deliveredSubscriberCount: 1,
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
    await registerOAuthCallbackPath("", "/oauth/callback");

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

  it("rejects unregistered heuristic OAuth callback paths with no fan-out", async () => {
    await register("oauth-miss", "https://dev-oauth-miss.example");
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/oauth-miss/oauth/callback?code=one-time"
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "oauth_callback_not_registered" });

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
      }>;
    };
    expect(body.inboundLog[0]).toMatchObject({
      kind: "oauth",
      result: "rejected",
      status: 404,
      error: "oauth_callback_not_registered",
      path: "/oauth/callback"
    });
  });

  it("does not proxy or fan out an allowlisted OAuth callback path without code or error", async () => {
    await register("oauth-empty", "https://dev-oauth-empty.example");
    await registerOAuthCallbackPath("oauth-empty", "/oauth/callback");
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/oauth-empty/oauth/callback"
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "oauth_callback_incomplete" });

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
      }>;
    };
    expect(body.inboundLog[0]).toMatchObject({
      kind: "oauth",
      result: "rejected",
      status: 404,
      error: "oauth_callback_incomplete",
      path: "/oauth/callback"
    });
  });

  it("proxies an OAuth callback that has error instead of code", async () => {
    await register("", "https://dev-oauth-error.example");
    await registerOAuthCallbackPath("", "/oauth/callback");
    fetchMock
      .get("https://dev-oauth-error.example")
      .intercept({ path: /\/oauth\/callback/, method: "GET" })
      .reply(302, "denied", {
        headers: { Location: "https://app.example/denied" }
      });

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/oauth/callback?error=access_denied&state=x"
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://app.example/denied");
  });

  it("rejects OAuth callbacks that are not GET or POST", async () => {
    await register("oauth-put", "https://dev-oauth-put.example");
    await registerOAuthCallbackPath("oauth-put", "/oauth/callback");
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/oauth-put/oauth/callback?code=one-time",
      { method: "PUT" }
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST");
    expect(await response.json()).toEqual({ error: "oauth_method_not_allowed" });
  });

  it("rejects public ingress bodies above the 768 KiB tunnel cap before forwarding", async () => {
    await register("too-large", "https://dev-too-large.example");
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/too-large/api/hooks/payment",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(TUNNEL_MAX_BODY_BYTES + 1)
      }
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request_too_large" });
  });

  it("returns the subscriber redirect for a correlated OAuth callback", async () => {
    const first = await register("oauth-route", "https://dev-oauth-a.example");
    await register("oauth-route", "https://dev-oauth-b.example");
    await registerOAuthCallbackPath("oauth-route", "/oauth/callback");
    await registerOAuthCallbackPath("oauth-route", "/api/auth/callback/google");

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
    await registerOAuthCallbackPath("oauth-ambiguous", "/oauth/callback");

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

  it("proxies nested /oolio/callback paths only when allowlisted", async () => {
    const first = await register("", "https://dev-oolio-a.example");
    await register("", "https://dev-oolio-b.example");
    await registerOAuthCallbackPath("", "/api/integrations/oolio/callback");

    fetchMock
      .get("https://dev-oolio-a.example")
      .intercept({ path: /\/api\/integrations\/oolio\/callback/, method: "GET" })
      .reply(302, "connected", {
        headers: { Location: "https://app.example/settings/integrations" }
      });

    const bind = await fetchWorker(
      `https://dev-webhooks.example.com/_router/subscribers/${first.subscriberId}/oauth-states`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ state: "oolio-orb-state" })
      }
    );
    expect(bind.status).toBe(200);

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/api/integrations/oolio/callback?code=one-time&state=oolio-orb-state"
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://app.example/settings/integrations"
    );
    expect(await response.text()).toBe("connected");
  });

  it("rejects missing, unknown, and expired /oolio/callback state instead of fanning out", async () => {
    const first = await register("", "https://dev-oolio-miss.example");
    await register("", "https://dev-oolio-other.example");
    await registerOAuthCallbackPath("", "/api/integrations/oolio/callback");

    const missing = await fetchWorker(
      "https://dev-webhooks.example.com/api/integrations/oolio/callback?code=one-time"
    );
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: "oauth_unroutable" });

    const unknown = await fetchWorker(
      "https://dev-webhooks.example.com/api/integrations/oolio/callback?code=one-time&state=unknown"
    );
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toMatchObject({ error: "oauth_unroutable" });

    const bind = await fetchWorker(
      `https://dev-webhooks.example.com/_router/subscribers/${first.subscriberId}/oauth-states`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ state: "expired-oolio-state" })
      }
    );
    expect(bind.status).toBe(200);

    const stub = env.ROUTE.getByName(durableObjectNameForRoute(""));
    await runInDurableObject(stub, async (_instance: RouteDurableObject, state) => {
      state.storage.sql.exec("UPDATE oauth_bindings SET expires_at = 0");
    });

    const expired = await fetchWorker(
      "https://dev-webhooks.example.com/api/integrations/oolio/callback?code=one-time&state=expired-oolio-state"
    );
    expect(expired.status).toBe(409);
    expect(await expired.json()).toMatchObject({ error: "oauth_unroutable" });
  });

  it("still fans out neighboring Oolio webhook paths", async () => {
    await register("", "https://dev-oolio-hook-a.example");
    await register("", "https://dev-oolio-hook-b.example");

    fetchMock
      .get("https://dev-oolio-hook-a.example")
      .intercept({ path: /\/api\/integrations\/oolio\/webhooks/, method: "POST" })
      .reply(200, "a");
    fetchMock
      .get("https://dev-oolio-hook-b.example")
      .intercept({ path: /\/api\/integrations\/oolio\/webhooks/, method: "POST" })
      .reply(200, "b");

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/api/integrations/oolio/webhooks?state=1&code=1",
      { method: "POST", body: "{}" }
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
  });

  it("routes a form-encoded OAuth callback and rejects an expired signed state", async () => {
    const first = await register("form-oauth", "https://dev-form-a.example");
    await register("form-oauth", "https://dev-form-b.example");
    await registerOAuthCallbackPath("form-oauth", "/oauth/callback");
    await registerOAuthCallbackPath("form-oauth", "/custom/redirect");

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

    const unsignedCustom = await fetchWorker(
      `https://dev-webhooks.example.com/form-oauth/other/redirect?code=abc&state=${encodeURIComponent(signed)}`
    );
    expect(unsignedCustom.status).toBe(404);
    expect(await unsignedCustom.json()).toEqual({ error: "oauth_callback_not_registered" });

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

  it("registers and deletes OAuth callback paths with the operator secret only", async () => {
    const created = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/allow-me/oauth-callback-paths",
      {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ path: "/api/auth/callback/google" })
      }
    );
    expect(created.status).toBe(200);

    const listed = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/allow-me/oauth-callback-paths",
      { headers: authHeaders() }
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      routeId: "allow-me",
      paths: ["/api/auth/callback/google"]
    });

    const routeSecret = await deriveRouteSecret(env.DEV_ROUTER_SECRET, "allow-me");
    const denied = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/allow-me/oauth-callback-paths",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${routeSecret}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ path: "/oauth/callback" })
      }
    );
    expect(denied.status).toBe(401);

    const removed = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/allow-me/oauth-callback-paths?path=%2Fapi%2Fauth%2Fcallback%2Fgoogle",
      { method: "DELETE", headers: authHeaders() }
    );
    expect(removed.status).toBe(204);

    const empty = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/allow-me/oauth-callback-paths",
      { headers: authHeaders() }
    );
    expect(await empty.json()).toEqual({ routeId: "allow-me", paths: [] });
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
    await registerOAuthCallbackPath("orb", "/oauth/callback");

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
    await registerOAuthCallbackPath("env-route", "/oauth/callback");

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

describe("webhook fan-out filters", () => {
  it("AC-02 filtered-to-zero still returns 202", async () => {
    await register("mute-all", "https://dev-mute-all.example");
    await putWebhookFanout("mute-all", true);

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/mute-all/api/hooks/payment",
      { method: "POST", body: "{}" }
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(await latestInbound()).toMatchObject({
      kind: "webhook",
      result: "accepted",
      status: 202,
      subscriberCount: 1,
      deliveredSubscriberCount: 0
    });
  });

  it("AC-03 filters do not keep a route open without subscribers", async () => {
    await putWebhookFanout("ghost-route", true);
    await putWebhookFanoutRule("ghost-route", { mode: "allow", path: "/webhooks/mews" });

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/ghost-route/webhooks/mews",
      { method: "POST", body: "{}" }
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "route_not_found" });
  });

  it("AC-08 allowlist delivers matching remaining paths only", async () => {
    await register("allow-mews", "https://dev-allow-mews.example");
    await putWebhookFanoutRule("allow-mews", { mode: "allow", path: "/webhooks/mews" });
    fetchMock
      .get("https://dev-allow-mews.example")
      .intercept({ path: "/webhooks/mews", method: "POST" })
      .reply(200, "ok");

    const matched = await fetchWorker(
      "https://dev-webhooks.example.com/allow-mews/webhooks/mews",
      { method: "POST", body: "{}" }
    );
    expect(matched.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(1);

    const skipped = await fetchWorker(
      "https://dev-webhooks.example.com/allow-mews/webhooks/stripe",
      { method: "POST", body: "{}" }
    );
    expect(skipped.status).toBe(202);
    expect(await skipped.json()).toEqual({ accepted: true });
    expect((await latestInbound()).deliveredSubscriberCount).toBe(0);
  });

  it("AC-09 denylist skips the matching prefix and delivers others", async () => {
    await register("deny-stripe", "https://dev-deny-stripe.example");
    await putWebhookFanoutRule("deny-stripe", { mode: "deny", path: "/webhooks/stripe" });
    fetchMock
      .get("https://dev-deny-stripe.example")
      .intercept({ path: "/webhooks/mews", method: "POST" })
      .reply(200, "ok");

    const skipped = await fetchWorker(
      "https://dev-webhooks.example.com/deny-stripe/webhooks/stripe/invoice",
      { method: "POST", body: "{}" }
    );
    expect(skipped.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(0);

    const matched = await fetchWorker(
      "https://dev-webhooks.example.com/deny-stripe/webhooks/mews",
      { method: "POST", body: "{}" }
    );
    expect(matched.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(1);
  });

  it("AC-11 scoped allow is opt-in for that environment only", async () => {
    await register("scoped-allow", "https://dev-env-a.example", "env-a");
    await register("scoped-allow", "https://dev-env-b.example", "env-b");
    await putWebhookFanoutRule("scoped-allow", {
      mode: "allow",
      path: "/webhooks/mews",
      environmentId: "env-a"
    });

    fetchMock
      .get("https://dev-env-a.example")
      .intercept({ path: "/webhooks/mews", method: "POST" })
      .reply(200, "ok");
    fetchMock
      .get("https://dev-env-b.example")
      .intercept({ path: "/webhooks/mews", method: "POST" })
      .reply(200, "ok");

    const mews = await fetchWorker(
      "https://dev-webhooks.example.com/scoped-allow/webhooks/mews",
      { method: "POST", body: "{}" }
    );
    expect(mews.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(2);

    fetchMock
      .get("https://dev-env-b.example")
      .intercept({ path: "/webhooks/stripe", method: "POST" })
      .reply(200, "ok");

    const stripe = await fetchWorker(
      "https://dev-webhooks.example.com/scoped-allow/webhooks/stripe",
      { method: "POST", body: "{}" }
    );
    expect(stripe.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(1);
  });

  it("AC-12 anonymous subscribers ignore environment-scoped rules", async () => {
    await register("anon-scope", "https://dev-anon.example");
    await putWebhookFanoutRule("anon-scope", {
      mode: "deny",
      path: "/webhooks/stripe",
      environmentId: "env-a"
    });
    fetchMock
      .get("https://dev-anon.example")
      .intercept({ path: "/webhooks/stripe", method: "POST" })
      .reply(200, "ok");

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/anon-scope/webhooks/stripe",
      { method: "POST", body: "{}" }
    );
    expect(response.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(1);
  });

  it("AC-13 rejects a 33rd webhook fan-out rule", async () => {
    for (let i = 0; i < 32; i += 1) {
      await putWebhookFanoutRule("rule-cap", { mode: "deny", path: `/webhooks/p${i}` });
    }
    const overflow = await fetchWorker(webhookFanoutUrl("rule-cap", true), {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ mode: "deny", path: "/webhooks/overflow" })
    });
    expect(overflow.status).toBe(400);
    expect(await overflow.json()).toEqual({ error: "webhook_fanout_rule_limit" });
  });

  it("AC-14 and AC-15 route deny-all skips everyone until unchecked", async () => {
    await register("deny-toggle", "https://dev-deny-a.example");
    await register("deny-toggle", "https://dev-deny-b.example");
    await putWebhookFanoutRule("deny-toggle", { mode: "allow", path: "/api/hooks/payment" });
    await putWebhookFanout("deny-toggle", true);

    const muted = await fetchWorker(
      "https://dev-webhooks.example.com/deny-toggle/api/hooks/payment",
      { method: "POST", body: "{}" }
    );
    expect(muted.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(0);

    await putWebhookFanout("deny-toggle", false);
    fetchMock
      .get("https://dev-deny-a.example")
      .intercept({ path: "/api/hooks/payment", method: "POST" })
      .reply(200, "ok");
    fetchMock
      .get("https://dev-deny-b.example")
      .intercept({ path: "/api/hooks/payment", method: "POST" })
      .reply(200, "ok");

    const restored = await fetchWorker(
      "https://dev-webhooks.example.com/deny-toggle/api/hooks/payment",
      { method: "POST", body: "{}" }
    );
    expect(restored.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(2);
  });

  it("AC-16 settings survive zero subscribers", async () => {
    const created = await register("persist-mute", "https://dev-persist-mute.example");
    await putWebhookFanout("persist-mute", true);
    await putWebhookFanoutRule("persist-mute", { mode: "deny", path: "/webhooks/stripe" });

    const removed = await fetchWorker(
      `https://dev-webhooks.example.com/_router/routes/persist-mute/subscribers/${created.subscriberId}`,
      { method: "DELETE", headers: authHeaders() }
    );
    expect(removed.status).toBe(204);

    const listed = await fetchWorker(webhookFanoutUrl("persist-mute"), {
      headers: authHeaders()
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      routeId: "persist-mute",
      denyAllWebhooks: true,
      rules: [expect.objectContaining({ mode: "deny", remainingPath: "/webhooks/stripe" })]
    });

    await register("persist-mute", "https://dev-persist-mute-2.example");
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/persist-mute/api/hooks/payment",
      { method: "POST", body: "{}" }
    );
    expect(response.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(0);
  });

  it("AC-17 subscriber acceptWebhooks false skips only that client", async () => {
    await register("opt-out", "https://dev-opt-a.example", undefined, false);
    await register("opt-out", "https://dev-opt-b.example");
    fetchMock
      .get("https://dev-opt-b.example")
      .intercept({ path: "/api/hooks/payment", method: "POST" })
      .reply(200, "ok");

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/opt-out/api/hooks/payment",
      { method: "POST", body: "{}" }
    );
    expect(response.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(1);
  });

  it("AC-18 environment reclaim overwrites acceptWebhooks", async () => {
    const first = await register(
      "reclaim-hooks",
      "https://dev-reclaim-a.example",
      "orb-1",
      false
    );
    const reclaimOn = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/reclaim-hooks/subscribers",
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          targetBaseUrl: "https://dev-reclaim-b.example",
          environmentId: "orb-1",
          acceptWebhooks: true,
          connectionToken: first.connectionToken
        })
      }
    );
    expect(reclaimOn.status).toBe(200);
    fetchMock
      .get("https://dev-reclaim-b.example")
      .intercept({ path: "/api/hooks/payment", method: "POST" })
      .reply(200, "ok");

    const accepted = await fetchWorker(
      "https://dev-webhooks.example.com/reclaim-hooks/api/hooks/payment",
      { method: "POST", body: "{}" }
    );
    expect(accepted.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(1);

    const reclaimed = (await reclaimOn.json()) as { connectionToken: string };
    const reclaimOff = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/reclaim-hooks/subscribers",
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          targetBaseUrl: "https://dev-reclaim-c.example",
          environmentId: "orb-1",
          acceptWebhooks: false,
          connectionToken: reclaimed.connectionToken
        })
      }
    );
    expect(reclaimOff.status).toBe(200);
    const denied = await fetchWorker(
      "https://dev-webhooks.example.com/reclaim-hooks/api/hooks/payment",
      { method: "POST", body: "{}" }
    );
    expect(denied.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(0);
  });

  it("AC-19 heartbeat does not reset acceptWebhooks", async () => {
    const created = await register(
      "heartbeat-mute",
      "https://dev-heartbeat-mute.example",
      undefined,
      false
    );
    const heartbeat = await fetchWorker(
      `https://dev-webhooks.example.com/_router/routes/heartbeat-mute/subscribers/${created.subscriberId}/heartbeat`,
      { method: "POST", headers: authHeaders() }
    );
    expect(heartbeat.status).toBe(200);

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/heartbeat-mute/api/hooks/payment",
      { method: "POST", body: "{}" }
    );
    expect(response.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(0);
  });

  it("AC-22 deny-all does not block allowlisted OAuth", async () => {
    await register("oauth-mute", "https://dev-oauth-mute.example");
    await registerOAuthCallbackPath("oauth-mute", "/oauth/callback");
    await putWebhookFanout("oauth-mute", true);
    fetchMock
      .get("https://dev-oauth-mute.example")
      .intercept({ path: /\/oauth\/callback/, method: "GET" })
      .reply(200, "oauth-ok");

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/oauth-mute/oauth/callback?code=123"
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("oauth-ok");
  });

  it("AC-23 --no-webhooks subscriber still receives correlated OAuth", async () => {
    await register("oauth-opt-out", "https://dev-oauth-opt.example", undefined, false);
    await registerOAuthCallbackPath("oauth-opt-out", "/oauth/callback");
    fetchMock
      .get("https://dev-oauth-opt.example")
      .intercept({ path: /\/oauth\/callback/, method: "GET" })
      .reply(302, "redirect", { headers: { Location: "/app" } });

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/oauth-opt-out/oauth/callback?code=123"
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app");
  });

  it("AC-25 status JSON includes webhookFanout and acceptWebhooks without secrets", async () => {
    await register("status-hooks", "https://dev-status-hooks.example", "env-status", false);
    await putWebhookFanout("status-hooks", true);
    await putWebhookFanoutRule("status-hooks", { mode: "deny", path: "/webhooks/stripe" });

    const status = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const body = (await status.json()) as {
      webhookFanout: {
        settings: Array<{ routeId: string; denyAllWebhooks: boolean }>;
        rules: Array<{ mode: string; remainingPath: string }>;
      };
      routes: Array<{ subscribers: Array<{ acceptWebhooks: boolean }> }>;
    };
    expect(body.webhookFanout.settings).toEqual([
      { routeId: "status-hooks", denyAllWebhooks: true }
    ]);
    expect(body.webhookFanout.rules).toEqual([
      expect.objectContaining({ mode: "deny", remainingPath: "/webhooks/stripe" })
    ]);
    expect(body.routes[0]?.subscribers[0]?.acceptWebhooks).toBe(false);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/"forwardToken"/);
    expect(serialized).not.toMatch(/"connectionToken"/);
    expect(serialized).not.toContain(env.DEV_ROUTER_SECRET);
  });

  it("AC-26 dashboard checkbox persists denyAllWebhooks", async () => {
    const headers = await dashboardHeaders({
      "Content-Type": "application/x-www-form-urlencoded"
    });
    const on = await fetchWorker("https://dev-webhooks.example.com/dashboard/webhook-fanout", {
      method: "POST",
      headers,
      body: "routeId=dash-mute&denyAllWebhooks=on",
      redirect: "manual"
    });
    expect(on.status).toBe(303);

    const status = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const body = (await status.json()) as {
      webhookFanout: { settings: Array<{ routeId: string; denyAllWebhooks: boolean }> };
    };
    expect(body.webhookFanout.settings).toContainEqual({
      routeId: "dash-mute",
      denyAllWebhooks: true
    });

    const off = await fetchWorker("https://dev-webhooks.example.com/dashboard/webhook-fanout", {
      method: "POST",
      headers: await dashboardHeaders({
        "Content-Type": "application/x-www-form-urlencoded"
      }),
      body: "routeId=dash-mute&denyAllWebhooks=off",
      redirect: "manual"
    });
    expect(off.status).toBe(303);
    const after = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const afterBody = (await after.json()) as {
      webhookFanout: { settings: Array<{ routeId: string; denyAllWebhooks: boolean }> };
    };
    expect(afterBody.webhookFanout.settings).toContainEqual({
      routeId: "dash-mute",
      denyAllWebhooks: false
    });
  });

  it("AC-27 dashboard adds and removes a path rule; invalid path is a no-op", async () => {
    const headers = await dashboardHeaders({
      "Content-Type": "application/x-www-form-urlencoded"
    });
    const created = await fetchWorker(
      "https://dev-webhooks.example.com/dashboard/webhook-fanout-rules",
      {
        method: "POST",
        headers,
        body: "routeId=dash-rules&mode=deny&path=%2Fwebhooks%2Fstripe",
        redirect: "manual"
      }
    );
    expect(created.status).toBe(303);

    const status = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const body = (await status.json()) as {
      webhookFanout: { rules: Array<{ remainingPath: string }> };
    };
    expect(body.webhookFanout.rules).toEqual([
      expect.objectContaining({ remainingPath: "/webhooks/stripe" })
    ]);

    const invalid = await fetchWorker(
      "https://dev-webhooks.example.com/dashboard/webhook-fanout-rules",
      {
        method: "POST",
        headers: await dashboardHeaders({
          "Content-Type": "application/x-www-form-urlencoded"
        }),
        body: "routeId=dash-rules&mode=deny&path=%2F",
        redirect: "manual"
      }
    );
    expect(invalid.status).toBe(303);
    const afterInvalid = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const afterInvalidBody = (await afterInvalid.json()) as {
      webhookFanout: { rules: Array<{ remainingPath: string }> };
    };
    expect(afterInvalidBody.webhookFanout.rules).toHaveLength(1);

    const removed = await fetchWorker(
      "https://dev-webhooks.example.com/dashboard/webhook-fanout-rules/delete",
      {
        method: "POST",
        headers: await dashboardHeaders({
          "Content-Type": "application/x-www-form-urlencoded"
        }),
        body: "routeId=dash-rules&mode=deny&path=%2Fwebhooks%2Fstripe",
        redirect: "manual"
      }
    );
    expect(removed.status).toBe(303);
    const empty = await fetchWorker("https://dev-webhooks.example.com/dashboard/status", {
      headers: await dashboardHeaders()
    });
    const emptyBody = (await empty.json()) as { webhookFanout: { rules: unknown[] } };
    expect(emptyBody.webhookFanout.rules).toEqual([]);
  });

  it("AC-28 unauthenticated dashboard webhook writes fail", async () => {
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/dashboard/webhook-fanout",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "routeId=nope&denyAllWebhooks=on"
      }
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });

    const listed = await fetchWorker(webhookFanoutUrl("nope"), { headers: authHeaders() });
    expect(await listed.json()).toMatchObject({ denyAllWebhooks: false, rules: [] });
  });

  it("AC-30 inbound delivered count is zero when a skip rule matches", async () => {
    await register("inbound-skip", "https://dev-inbound-skip.example");
    await putWebhookFanoutRule("inbound-skip", { mode: "deny", path: "/api/hooks/payment" });

    const skipped = await fetchWorker(
      "https://dev-webhooks.example.com/inbound-skip/api/hooks/payment?customer=SHOULD-NOT-LOG",
      { method: "POST", body: "{}" }
    );
    expect(skipped.status).toBe(202);
    expect(await latestInbound()).toMatchObject({
      kind: "webhook",
      result: "accepted",
      status: 202,
      path: "/api/hooks/payment",
      hasQuery: true,
      subscriberCount: 1,
      deliveredSubscriberCount: 0
    });

    fetchMock
      .get("https://dev-inbound-skip.example")
      .intercept({ path: "/api/hooks/other", method: "POST" })
      .reply(200, "ok");
    const delivered = await fetchWorker(
      "https://dev-webhooks.example.com/inbound-skip/api/hooks/other",
      { method: "POST", body: "{}" }
    );
    expect(delivered.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(1);
  });

  it("AC-31 operator secret can CRUD webhook fan-out settings on root and named routes", async () => {
    const named = await fetchWorker(webhookFanoutUrl("crud-named"), {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ denyAllWebhooks: true })
    });
    expect(named.status).toBe(200);
    expect(await named.json()).toMatchObject({
      routeId: "crud-named",
      denyAllWebhooks: true,
      rules: []
    });

    const rule = await fetchWorker(webhookFanoutUrl("crud-named", true), {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ mode: "allow", path: "/webhooks/mews" })
    });
    expect(rule.status).toBe(200);
    expect(await rule.json()).toMatchObject({
      routeId: "crud-named",
      mode: "allow",
      remainingPath: "/webhooks/mews",
      environmentId: null
    });

    const listed = await fetchWorker(webhookFanoutUrl("crud-named"), {
      headers: authHeaders()
    });
    expect(await listed.json()).toMatchObject({
      denyAllWebhooks: true,
      rules: [expect.objectContaining({ remainingPath: "/webhooks/mews" })]
    });

    const removed = await fetchWorker(
      `${webhookFanoutUrl("crud-named", true)}?mode=allow&path=%2Fwebhooks%2Fmews`,
      { method: "DELETE", headers: authHeaders() }
    );
    expect(removed.status).toBe(204);

    const root = await fetchWorker(webhookFanoutUrl(""), {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ denyAllWebhooks: true })
    });
    expect(root.status).toBe(200);
    expect(await root.json()).toMatchObject({ routeId: "", denyAllWebhooks: true });
  });

  it("AC-32 join token cannot mutate webhook fan-out settings", async () => {
    const routeSecret = await deriveRouteSecret(env.DEV_ROUTER_SECRET, "join-mute");
    const denied = await fetchWorker(webhookFanoutUrl("join-mute"), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${routeSecret}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ denyAllWebhooks: true })
    });
    expect(denied.status).toBe(401);

    const deniedRule = await fetchWorker(webhookFanoutUrl("join-mute", true), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${routeSecret}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ mode: "deny", path: "/webhooks/stripe" })
    });
    expect(deniedRule.status).toBe(401);
  });

  it("AC-33 join token can set own acceptWebhooks", async () => {
    const routeSecret = await deriveRouteSecret(env.DEV_ROUTER_SECRET, "join-opt");
    const created = await fetchWorker(
      "https://dev-webhooks.example.com/_router/routes/join-opt/subscribers",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${routeSecret}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          targetBaseUrl: "https://dev-join-opt.example",
          acceptWebhooks: false
        })
      }
    );
    expect(created.status).toBe(200);

    const response = await fetchWorker(
      "https://dev-webhooks.example.com/join-opt/api/hooks/payment",
      { method: "POST", body: "{}" }
    );
    expect(response.status).toBe(202);
    expect((await latestInbound()).deliveredSubscriberCount).toBe(0);
  });
});

async function latestInbound(): Promise<{
  kind: string;
  result: string;
  status: number;
  path: string;
  hasQuery: boolean;
  subscriberCount: number;
  deliveredSubscriberCount: number;
}> {
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
      subscriberCount: number;
      deliveredSubscriberCount: number;
    }>;
  };
  expect(body.inboundLog[0]).toBeDefined();
  return body.inboundLog[0]!;
}

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
