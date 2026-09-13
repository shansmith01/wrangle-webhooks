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

  const explicitTarget = values.target ?? process.env.PUBLIC_DEV_URL;
  const detected = explicitTarget ? undefined : detectPublicDevUrl(process.env, port);
  const targetBaseUrl = explicitTarget ?? detected?.url;

  if (!routerUrl || !secret) {
    console.error(
      "Missing configuration. Set DEV_ROUTER_URL and DEV_ROUTER_SECRET, or pass --url and --secret."
    );
    process.exit(1);
  }

  if (!targetBaseUrl) {
    console.error("A target URL is required.");
    process.exit(1);
  }

  const client = new DevRouterClient({ routerUrl, secret });
  const connection = await client.connect({
    routeId,
    targetBaseUrl,
    port: port ?? resolveDevPort(process.env)
  });

  console.log("Dev router connected");
  console.log("");
  console.log("Public:");
  console.log(connection.publicUrl);
  console.log("");
  console.log("Forwarding to:");
  console.log(`${connection.targetBaseUrl}/*`);
  if (detected) {
    console.log(`(detected from ${detected.source})`);
  }
  console.log("");
  console.log("Press Ctrl+C to disconnect.");

  await waitForShutdownSignal();
  await connection.disconnect();
}

function printUsage(): void {
  console.log(`Usage:
  npx dev-router connect
  npx dev-router connect --route my-web-app --port 3000

The client detects this environment's public URL automatically.
If nothing is detected, it uses https://dev-router-test.example so you can
exercise registration locally. That target will not receive real traffic.
route is optional. When omitted, traffic is accepted at the router root
(https://dev-webhooks.example.com/*) with no project prefix.
Use --route only when you want a path prefix for this project.

Environment:
  DEV_ROUTER_URL      Shared router base URL
  DEV_ROUTER_SECRET   Management bearer secret
  DEV_ROUTER_ROUTE    Optional public path prefix for this project
  DEV_ROUTER_PORT     Local app port used when constructing the detected URL (default 3000)
  PUBLIC_DEV_URL      Optional override for the environment's public URL`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
