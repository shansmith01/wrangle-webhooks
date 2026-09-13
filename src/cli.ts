import { parseArgs } from "node:util";
import { resolveCliCommand } from "./cli-command";
import { DevRouterClient } from "./client";
import { detectPublicDevUrl, resolveDevPort } from "./detect-url";
import { waitForShutdownSignal } from "./wait-for-shutdown";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      route: { type: "string" },
      target: { type: "string" },
      "local-url": { type: "string" },
      port: { type: "string" },
      url: { type: "string" },
      secret: { type: "string" },
      help: { type: "boolean", short: "h" }
    }
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const command = resolveCliCommand(positionals);
  if (command !== "connect") {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const routerUrl = values.url ?? process.env.DEV_ROUTER_URL;
  const secret = values.secret ?? process.env.DEV_ROUTER_SECRET;
  const routeId = values.route ?? process.env.DEV_ROUTER_ROUTE ?? "";
  const port = values.port ? Number.parseInt(values.port, 10) : undefined;
  if (values.port && (!Number.isInteger(port) || (port ?? 0) <= 0)) {
    console.error("--port must be a positive integer");
    process.exit(1);
  }

  const localUrl = values["local-url"] ?? process.env.DEV_ROUTER_LOCAL_URL;
  const explicitTarget = values.target ?? process.env.PUBLIC_DEV_URL;

  if (localUrl && explicitTarget) {
    console.error("--local-url and --target are mutually exclusive.");
    process.exit(1);
  }

  const detected = !localUrl && !explicitTarget ? detectPublicDevUrl(process.env, port) : undefined;
  const targetBaseUrl = explicitTarget ?? detected?.url;

  if (!routerUrl || !secret) {
    console.error(
      "Missing configuration. Set DEV_ROUTER_URL and DEV_ROUTER_SECRET, or pass --url and --secret."
    );
    process.exit(1);
  }

  if (!localUrl && !targetBaseUrl) {
    console.error("A target URL or --local-url is required.");
    process.exit(1);
  }

  const client = new DevRouterClient({ routerUrl, secret });
  const connection = await client.connect({
    routeId,
    localUrl,
    targetBaseUrl: localUrl ? undefined : targetBaseUrl,
    port: port ?? resolveDevPort(process.env)
  });

  console.log(
    connection.transport === "tunnel"
      ? "Dev router connected (reverse tunnel)"
      : "Dev router connected"
  );
  console.log("");
  console.log("Public:");
  console.log(connection.publicUrl);
  console.log("");
  console.log("Forwarding to:");
  console.log(`${connection.targetBaseUrl}/*`);
  if (connection.transport === "tunnel") {
    console.log("(local reverse tunnel; the Worker cannot see this URL)");
  } else if (detected) {
    console.log(`(detected from ${detected.source})`);
  }
  console.log("");
  console.log("Replica mode: this environment is subscribed, not yet provider-ready.");
  console.log("Next step: complete the app's OAuth to the third-party provider in this");
  console.log("environment. Use the Public URL as the redirect URI. Tokens stay here;");
  console.log("a new orb must OAuth again before webhook follow-up will work.");
  console.log("");
  console.log("Press Ctrl+C to disconnect.");

  await waitForShutdownSignal();
  await connection.disconnect();
}

function printUsage(): void {
  console.log(`Usage:
  npx dev-router connect --route nomads --local-url http://127.0.0.1:3000
  npx dev-router connect --route my-web-app --port 3000
  npx dev-router connect --target https://abc123.cloud-dev.example

Reverse tunnel (--local-url) is the default for private cloud environments
such as Amp orbs, Codespaces, Cursor, CI workers, and containers. The sidecar
opens an outbound WebSocket and forwards requests to the local HTTP server.

Public-target (--target / PUBLIC_DEV_URL) remains available when the
environment already has a public https:// origin the Worker can fetch.

route is optional. When omitted, traffic is accepted at the router root
(https://dev-webhooks.example.com/*) with no project prefix.

Environment:
  DEV_ROUTER_URL        Shared router base URL
  DEV_ROUTER_SECRET     Management bearer secret
  DEV_ROUTER_ROUTE      Optional public path prefix for this project
  DEV_ROUTER_PORT       Local app port used when constructing a detected URL (default 3000)
  DEV_ROUTER_LOCAL_URL  Local HTTP origin for reverse-tunnel mode
  PUBLIC_DEV_URL        Optional public https:// origin (public-target transport)`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
