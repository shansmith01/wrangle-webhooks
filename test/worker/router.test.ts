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
  targetBaseUrl: string
): Promise<{ subscriberId: string }> {
  const response = await fetchWorker(
    `https://dev-webhooks.example.com/_router/routes/${routeId}/subscribers`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ targetBaseUrl })
    }
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { subscriberId: string };
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

    fetchMock
      .get("https://dev-a.example")
      .intercept({ path: /\/api\/hooks\/payment/, method: "POST" })
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
  });

  it("does not forward the reserved management namespace", async () => {
    const response = await fetchWorker(
      "https://dev-webhooks.example.com/_router/unknown",
      { headers: authHeaders() }
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
