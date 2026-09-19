import { afterEach, expect, test, vi } from "vitest";
import { DevRouterClient } from "../../src/client";
import { HEARTBEAT_INTERVAL_MS } from "../../src/subscriber-lifetime";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type ManagementRequest = {
  url: string;
  method: string;
  authorization: string | null;
  body: string;
};

function headersFromInit(init?: RequestInit): Headers {
  return init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
}

function stubManagementFetch(
  handler: (request: ManagementRequest) => Response | Promise<Response>
): ManagementRequest[] {
  const requests: ManagementRequest[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request: ManagementRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headersFromInit(init).get("Authorization"),
      body: String(init?.body ?? "")
    };
    requests.push(request);
    return handler(request);
  });
  return requests;
}

test("registers a subscriber and deregisters on disconnect", async () => {
  const requests = stubManagementFetch((request) => {
    if (request.url.endsWith("/subscribers") && request.method === "POST") {
      return Response.json({
        subscriberId: "sub_abc123",
        routeId: "my-web-app",
        expiresIn: 300,
        forwardToken: "ft_testtoken"
      });
    }
    if (request.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  });

  const client = new DevRouterClient({
    routerUrl: "https://dev-webhooks.example.com",
    secret: "test-secret"
  });
  const connection = await client.connect({
    routeId: "my-web-app",
    targetBaseUrl: "https://abc123.cloud-dev.example",
    environmentId: "codespace-1"
  });

  expect(connection.subscriberId).toBe("sub_abc123");
  expect(connection.forwardToken).toBe("ft_testtoken");
  expect(connection.transport).toBe("public");
  expect(connection.publicUrl).toBe("https://dev-webhooks.example.com/my-web-app/*");
  expect(connection.environmentId).toBe("codespace-1");
  expect(connection.connected).toBe(true);
  expect(connection.acceptWebhooks).toBe(true);
  expect(requests[0]).toMatchObject({
    url: "https://dev-webhooks.example.com/_router/routes/my-web-app/subscribers",
    method: "POST",
    authorization: "Bearer test-secret"
  });
  expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
    targetBaseUrl: "https://abc123.cloud-dev.example",
    environmentId: "codespace-1"
  });
  expect(JSON.parse(requests[0]?.body ?? "{}").acceptWebhooks).toBeUndefined();

  await connection.disconnect();
  expect(connection.connected).toBe(false);
  expect(requests.at(-1)).toMatchObject({
    url: expect.stringContaining("subscribers/sub_abc123"),
    method: "DELETE"
  });
});

test("AC-20 register JSON includes acceptWebhooks false when this subscriber denies webhooks", async () => {
  const requests = stubManagementFetch((request) => {
    if (request.method === "POST") {
      return Response.json({
        subscriberId: "sub_mute",
        routeId: "my-web-app",
        expiresIn: 300,
        forwardToken: "ft_testtoken"
      });
    }
    return new Response(null, { status: 204 });
  });

  const client = new DevRouterClient({
    routerUrl: "https://dev-webhooks.example.com",
    secret: "test-secret"
  });
  const connection = await client.connect({
    routeId: "my-web-app",
    targetBaseUrl: "https://abc123.cloud-dev.example",
    acceptWebhooks: false
  });
  expect(connection.acceptWebhooks).toBe(false);
  expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
    targetBaseUrl: "https://abc123.cloud-dev.example",
    acceptWebhooks: false
  });
  await connection.disconnect();
});

test("detects the environment public URL when targetBaseUrl is omitted", async () => {
  stubManagementFetch((request) => {
    if (request.method === "POST") {
      return Response.json({
        subscriberId: "sub_abc123",
        routeId: "my-web-app",
        expiresIn: 300
      });
    }
    return new Response(null, { status: 204 });
  });

  const client = new DevRouterClient({
    routerUrl: "https://dev-webhooks.example.com",
    secret: "test-secret"
  });

  async function connectDetected(
    env: Record<string, string>,
    port?: number
  ): Promise<string> {
    vi.unstubAllEnvs();
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    const connection = await client.connect({ routeId: "my-web-app", port });
    const targetBaseUrl = connection.targetBaseUrl;
    await connection.disconnect();
    return targetBaseUrl;
  }

  expect(
    await connectDetected(
      { VSCODE_PROXY_URI: "https://abc-{{port}}.use.devtunnels.ms" },
      3000
    )
  ).toBe("https://abc-3000.use.devtunnels.ms");
  expect(
    await connectDetected({
      CODESPACE_NAME: "lucky-space-abc123",
      GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
      DEV_ROUTER_PORT: "4173"
    })
  ).toBe("https://lucky-space-abc123-4173.app.github.dev");
  expect(
    await connectDetected(
      { GITPOD_WORKSPACE_URL: "https://shannon-demo-abc.gitpod.io" },
      3000
    )
  ).toBe("https://3000-shannon-demo-abc.gitpod.io");
  expect(await connectDetected({ REPLIT_DEV_DOMAIN: "my-repl.replit.dev" })).toBe(
    "https://my-repl.replit.dev"
  );
  expect(await connectDetected({})).toBe("https://dev-router-test.example");
});

test("registers at the router root when routeId is omitted", async () => {
  const requests = stubManagementFetch((request) => {
    if (request.method === "POST") {
      return Response.json({
        subscriberId: "sub_abc123",
        routeId: "",
        expiresIn: 300,
        forwardToken: "ft_testtoken"
      });
    }
    return new Response(null, { status: 204 });
  });

  const client = new DevRouterClient({
    routerUrl: "https://dev-webhooks.example.com",
    secret: "test-secret"
  });
  const connection = await client.connect({
    targetBaseUrl: "https://abc123.cloud-dev.example"
  });

  expect(connection.routeId).toBe("");
  expect(connection.publicUrl).toBe("https://dev-webhooks.example.com/*");
  expect(requests[0]?.url).toBe("https://dev-webhooks.example.com/_router/subscribers");
  await connection.disconnect();
});

test("rejects invalid localUrl, routeId, environmentId, and mixed transports", async () => {
  const client = new DevRouterClient({
    routerUrl: "https://dev-webhooks.example.com",
    secret: "test-secret"
  });
  await expect(
    client.connect({
      localUrl: "http://127.0.0.1:3000",
      targetBaseUrl: "https://abc123.cloud-dev.example"
    })
  ).rejects.toThrow(/mutually exclusive/);
  await expect(
    client.connect({ localUrl: "http://user:pass@127.0.0.1:3000" })
  ).rejects.toThrow(/credentials/);
  await expect(
    client.connect({ localUrl: "http://127.0.0.1:3000/#x" })
  ).rejects.toThrow(/fragment/);
  await expect(
    client.connect({
      routeId: "dashboard",
      targetBaseUrl: "https://abc123.cloud-dev.example"
    })
  ).rejects.toThrow(/routeId/);
  await expect(
    client.connect({
      environmentId: "has space",
      targetBaseUrl: "https://abc123.cloud-dev.example"
    })
  ).rejects.toThrow(/environmentId/);
});

test("open() returns a connecting client before registration completes", async () => {
  let release!: (value: Response) => void;
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal("fetch", async () => gate);

  const client = new DevRouterClient({
    routerUrl: "https://dev-webhooks.example.com",
    secret: "test-secret"
  });
  const connection = client.open({
    routeId: "my-web-app",
    targetBaseUrl: "https://abc123.cloud-dev.example"
  });
  expect(connection.connected).toBe(false);
  expect(connection.connectionState).toBe("connecting");

  release(
    Response.json({
      subscriberId: "sub_abc123",
      routeId: "my-web-app",
      expiresIn: 300,
      forwardToken: "ft_testtoken"
    })
  );
  await connection.whenReady();
  expect(connection.connected).toBe(true);
  expect(connection.connectionState).toBe("connected");
  await connection.disconnect();
});

test("records unauthorized when join returns 401 and ignores a later network error", async () => {
  vi.useFakeTimers();
  let attempts = 0;
  stubManagementFetch(() => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("unavailable", { status: 503 });
  });

  const client = new DevRouterClient({
    routerUrl: "https://dev-webhooks.example.com",
    secret: "wrong-secret"
  });
  const connection = client.open({
    targetBaseUrl: "https://abc123.cloud-dev.example"
  });
  await vi.waitFor(() => {
    expect(connection.connectionState).toBe("unauthorized");
  });
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => {
    expect(attempts).toBeGreaterThanOrEqual(2);
  });
  expect(connection.connectionState).toBe("unauthorized");
  expect(connection.connected).toBe(false);
  await connection.disconnect();
});

test("posts a heartbeat and re-registers when the subscriber is gone", async () => {
  vi.useFakeTimers();
  const methods: string[] = [];
  stubManagementFetch((request) => {
    if (request.url.endsWith("/subscribers") && request.method === "POST") {
      methods.push("register");
      return Response.json({
        subscriberId: methods.filter((item) => item === "register").length === 1
          ? "sub_alive"
          : "sub_rejoined",
        routeId: "my-web-app",
        expiresIn: 300,
        forwardToken: "ft_testtoken",
        connectionToken: "ct_test"
      });
    }
    if (request.url.includes("/heartbeat") && request.method === "POST") {
      methods.push("heartbeat");
      return new Response(JSON.stringify({ error: "subscriber_not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (request.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  });

  const client = new DevRouterClient({
    routerUrl: "https://dev-webhooks.example.com",
    secret: "test-secret"
  });
  const connection = await client.connect({
    routeId: "my-web-app",
    targetBaseUrl: "https://abc123.cloud-dev.example"
  });
  expect(connection.subscriberId).toBe("sub_alive");
  expect(connection.connected).toBe(true);
  expect(methods).toEqual(["register"]);

  await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
  expect(methods).toEqual(["register", "heartbeat", "register"]);
  expect(connection.subscriberId).toBe("sub_rejoined");
  expect(connection.connected).toBe(true);

  await connection.disconnect();
});

test("retries registration after a transient failure then connects", async () => {
  vi.useFakeTimers();
  let attempts = 0;
  stubManagementFetch((request) => {
    if (request.method === "POST") {
      attempts += 1;
      if (attempts === 1) {
        return new Response("unavailable", { status: 503 });
      }
      return Response.json({
        subscriberId: "sub_retry",
        routeId: "my-web-app",
        expiresIn: 300,
        forwardToken: "ft_retry",
        connectionToken: "ct_retry"
      });
    }
    return new Response(null, { status: 204 });
  });

  const client = new DevRouterClient({
    routerUrl: "https://dev-webhooks.example.com",
    secret: "test-secret"
  });
  const connection = client.open({
    routeId: "my-web-app",
    targetBaseUrl: "https://abc123.cloud-dev.example"
  });
  await vi.waitFor(() => {
    expect(connection.connectionState).toBe("network_error");
  });
  expect(connection.connected).toBe(false);
  expect(attempts).toBe(1);

  const ready = connection.whenReady();
  await vi.advanceTimersByTimeAsync(1_000);
  await ready;
  expect(connection.connected).toBe(true);
  expect(connection.connectionState).toBe("connected");
  expect(connection.subscriberId).toBe("sub_retry");
  await connection.disconnect();
});
