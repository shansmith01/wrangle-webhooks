import { parseArgs } from "node:util";
import { DevRouterClient } from "./client";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      route: { type: "string" },
      target: { type: "string" },
      url: { type: "string" },
      secret: { type: "string" },
      help: { type: "boolean", short: "h" }
    }
  });

  const command = positionals[0];
  if (values.help || !command) {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  if (command !== "connect") {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const routerUrl = values.url ?? process.env.DEV_ROUTER_URL;
  const secret = values.secret ?? process.env.DEV_ROUTER_SECRET;
  const routeId = values.route ?? process.env.DEV_ROUTER_ROUTE;
  const targetBaseUrl = values.target ?? process.env.PUBLIC_DEV_URL;

  if (!routerUrl || !secret || !routeId || !targetBaseUrl) {
    console.error(
      "Missing configuration. Set DEV_ROUTER_URL, DEV_ROUTER_SECRET, DEV_ROUTER_ROUTE, and PUBLIC_DEV_URL, or pass --url, --secret, --route, and --target."
    );
    process.exit(1);
  }

  const client = new DevRouterClient({ routerUrl, secret });
  const connection = await client.connect({ routeId, targetBaseUrl });

  console.log("Dev router connected");
  console.log("");
  console.log("Public:");
  console.log(connection.publicUrl);
  console.log("");
  console.log("Forwarding to:");
  console.log(`${connection.targetBaseUrl}/*`);

  await new Promise<void>((resolve) => {
    const finish = (): void => resolve();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });

  await connection.disconnect();
}

function printUsage(): void {
  console.log(`Usage:
  npx dev-router connect
  npx dev-router connect --route my-web-app --target https://abc123.cloud-dev.example

Environment:
  DEV_ROUTER_URL      Shared router base URL
  DEV_ROUTER_SECRET   Management bearer secret
  DEV_ROUTER_ROUTE    Route ID for this project
  PUBLIC_DEV_URL      Externally reachable URL for this environment`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
