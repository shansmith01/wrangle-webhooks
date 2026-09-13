import { describe, expect, it } from "vitest";
import { detectPublicDevUrl, resolveDevPort } from "../../src/detect-url";

describe("resolveDevPort", () => {
  it("prefers an explicit port", () => {
    expect(resolveDevPort({ PORT: "4000" }, 5173)).toBe(5173);
  });

  it("uses DEV_ROUTER_PORT then PORT then 3000", () => {
    expect(resolveDevPort({ DEV_ROUTER_PORT: "4173", PORT: "4000" })).toBe(4173);
    expect(resolveDevPort({ PORT: "4000" })).toBe(4000);
    expect(resolveDevPort({})).toBe(3000);
  });
});

describe("detectPublicDevUrl", () => {
  it("uses VS Code port forwarding when available", () => {
    expect(
      detectPublicDevUrl(
        { VSCODE_PROXY_URI: "https://abc-{{port}}.use.devtunnels.ms" },
        3000
      )
    ).toEqual({
      url: "https://abc-3000.use.devtunnels.ms",
      source: "VS Code port forwarding"
    });
  });

  it("constructs a GitHub Codespaces URL", () => {
    expect(
      detectPublicDevUrl({
        CODESPACE_NAME: "lucky-space-abc123",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
        PORT: "3000"
      })
    ).toEqual({
      url: "https://lucky-space-abc123-3000.app.github.dev",
      source: "GitHub Codespaces"
    });
  });

  it("constructs a Gitpod URL", () => {
    expect(
      detectPublicDevUrl(
        { GITPOD_WORKSPACE_URL: "https://shannon-demo-abc.gitpod.io" },
        3000
      )
    ).toEqual({
      url: "https://3000-shannon-demo-abc.gitpod.io",
      source: "Gitpod"
    });
  });

  it("uses the Replit domain", () => {
    expect(
      detectPublicDevUrl({ REPLIT_DEV_DOMAIN: "my-repl.replit.dev" })
    ).toEqual({
      url: "https://my-repl.replit.dev",
      source: "Replit"
    });
  });

  it("returns undefined when nothing can be detected", () => {
    expect(detectPublicDevUrl({})).toBeUndefined();
  });
});
