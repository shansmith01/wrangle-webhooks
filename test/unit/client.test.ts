import { afterEach, describe, expect, it, vi } from "vitest";
import { DevRouterClient } from "../../src/client";

describe("DevRouterClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers, heartbeats are scheduled, and disconnect deregisters", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/subscribers") && init?.method === "POST") {
        return Response.json({
          subscriberId: "sub_abc123",
          routeId: "my-web-app",
          expiresIn: 300
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
      targetBaseUrl: "https://abc123.cloud-dev.example"
    });

    expect(connection.subscriberId).toBe("sub_abc123");
    expect(connection.publicUrl).toBe("https://dev-webhooks.example.com/my-web-app/*");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    expect(String(firstCall[0])).toBe(
      "https://dev-webhooks.example.com/_router/routes/my-web-app/subscribers"
    );
    expect(firstCall[1]?.headers).toBeInstanceOf(Headers);
    expect((firstCall[1]?.headers as Headers).get("Authorization")).toBe("Bearer test-secret");

    await connection.disconnect();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("subscribers/sub_abc123");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
  });
});
