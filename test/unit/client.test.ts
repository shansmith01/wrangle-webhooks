import { afterEach, describe, expect, it, vi } from "vitest";
import { DevRouterClient } from "../../src/client";

describe("DevRouterClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("registers, heartbeats are scheduled, and disconnect deregisters", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/subscribers") && init?.method === "POST") {
        return Response.json({
          subscriberId: "sub_abc123",
          routeId: "my-web-app",
          expiresIn: 300,
          forwardToken: "ft_testtoken"
        });
      }
      if (url.includes("/heartbeat")) {
        return Response.json({
          subscriberId: "sub_abc123",
          routeId: "my-web-app",
          expiresIn: 300
        });
      }
      if (init?.method === "DELETE") {
        expect(init.signal?.aborted).not.toBe(true);
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    expect(String(firstCall[0])).toBe(
      "https://dev-webhooks.example.com/_router/routes/my-web-app/subscribers"
    );
    expect(firstCall[1]?.headers).toBeInstanceOf(Headers);
    expect((firstCall[1]?.headers as Headers).get("Authorization")).toBe("Bearer test-secret");
    expect(String(firstCall[1]?.body)).toContain("codespace-1");

    await connection.disconnect();
    expect(connection.connected).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("subscribers/sub_abc123");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
  });

  it("detects the environment public URL when targetBaseUrl is omitted", async () => {
    vi.stubEnv("CODESPACE_NAME", "lucky-space-abc123");
    vi.stubEnv("GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN", "app.github.dev");

    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Response.json({
          subscriberId: "sub_abc123",
          routeId: "my-web-app",
          expiresIn: 300
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new DevRouterClient({
      routerUrl: "https://dev-webhooks.example.com",
      secret: "test-secret"
    });
    const connection = await client.connect({ routeId: "my-web-app" });
    expect(connection.targetBaseUrl).toBe(
      "https://lucky-space-abc123-3000.app.github.dev"
    );
    const body = String(fetchMock.mock.calls[0][1]?.body);
    expect(body).toContain("https://lucky-space-abc123-3000.app.github.dev");
    await connection.disconnect();
  });

  it("registers at the router root when routeId is omitted", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Response.json({
          subscriberId: "sub_abc123",
          routeId: "",
          expiresIn: 300,
          forwardToken: "ft_testtoken"
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new DevRouterClient({
      routerUrl: "https://dev-webhooks.example.com",
      secret: "test-secret"
    });
    const connection = await client.connect({
      targetBaseUrl: "https://abc123.cloud-dev.example"
    });

    expect(connection.routeId).toBe("");
    expect(connection.publicUrl).toBe("https://dev-webhooks.example.com/*");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://dev-webhooks.example.com/_router/subscribers"
    );
    await connection.disconnect();
  });

  it("rejects localUrl and targetBaseUrl together", async () => {
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
  });

  it("open() returns a connecting client before registration completes", async () => {
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => gate)
    );

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

  it("records unauthorized when join returns 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 }))
    );

    const client = new DevRouterClient({
      routerUrl: "https://dev-webhooks.example.com",
      secret: "wrong-secret"
    });
    const connection = client.open({
      targetBaseUrl: "https://abc123.cloud-dev.example"
    });
    await expect.poll(() => connection.connectionState).toBe("unauthorized");
    expect(connection.connected).toBe(false);
    await connection.disconnect();
  });
});
