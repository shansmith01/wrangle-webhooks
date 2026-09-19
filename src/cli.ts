import { parseArgs } from "node:util";
import { resolveCliCommand } from "./cli-command";
import { DevRouterClient, deriveRouteSecret, startControlServer } from "./client";
import { CONTROL_DEFAULT_PORT } from "./control-server";
import { detectPublicDevUrl, resolveDevPort } from "./detect-url";
import { forwardingDisplayUrl } from "./ingress-urls";
import { isAllowedEnvironmentId, isAllowedRouteId } from "./route-id";
import { resolveAcceptWebhooks } from "./accept-webhooks";
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
      "environment-id": { type: "string" },
      "no-webhooks": { type: "boolean" },
      "control-port": { type: "string" },
      "control-socket": { type: "string" },
      "control-token": { type: "string" },
      "no-control": { type: "boolean" },
      help: { type: "boolean", short: "h" }
    }
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const command = resolveCliCommand(positionals);
  const routerUrl = values.url ?? process.env.DEV_ROUTER_URL;
  const secret = values.secret ?? process.env.DEV_ROUTER_SECRET;
  const routeId = values.route ?? process.env.DEV_ROUTER_ROUTE ?? "";

  if (command === "token") {
    await printRouteToken(secret, routeId);
    return;
  }

  if (command !== "connect") {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const port = values.port ? Number.parseInt(values.port, 10) : undefined;
  if (values.port && (!Number.isInteger(port) || (port ?? 0) <= 0)) {
    console.error("--port must be a positive integer");
    process.exit(1);
  }

  const localUrl = values["local-url"] ?? process.env.DEV_ROUTER_LOCAL_URL;
  const explicitTarget = values.target ?? process.env.PUBLIC_DEV_URL;
  const environmentId =
    values["environment-id"] ?? process.env.DEV_ROUTER_ENVIRONMENT_ID;
  const acceptWebhooks = resolveAcceptWebhooks({
    flag: values["no-webhooks"] === true,
    envValue: process.env.DEV_ROUTER_NO_WEBHOOKS
  });

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

  if (environmentId && !isAllowedEnvironmentId(environmentId)) {
    console.error("--environment-id is invalid.");
    process.exit(1);
  }

  const controlPortRaw = values["control-port"] ?? process.env.DEV_ROUTER_CONTROL_PORT;
  const controlPort = controlPortRaw ? Number.parseInt(controlPortRaw, 10) : CONTROL_DEFAULT_PORT;
  if (controlPortRaw && (!Number.isInteger(controlPort) || controlPort <= 0)) {
    console.error("--control-port must be a positive integer");
    process.exit(1);
  }

  const client = new DevRouterClient({ routerUrl, secret });
  const connection = client.open({
    routeId,
    localUrl,
    targetBaseUrl: localUrl ? undefined : targetBaseUrl,
    port: port ?? resolveDevPort(process.env),
    environmentId,
    acceptWebhooks
  });

  const control =
    values["no-control"]
      ? null
      : await startControlServer(connection, {
          port: controlPort,
          socketPath: values["control-socket"] ?? process.env.DEV_ROUTER_CONTROL_SOCKET,
          token: values["control-token"] ?? process.env.DEV_ROUTER_CONTROL_TOKEN
        });

  console.log(
    connection.transport === "tunnel"
      ? "Dev router starting (reverse tunnel)"
      : "Dev router starting"
  );
  console.log("");
  console.log("Public:");
  console.log(connection.publicUrl);
  console.log("");
  console.log("Forwarding to:");
  console.log(forwardingDisplayUrl(connection.targetBaseUrl));
  if (connection.transport === "tunnel") {
    console.log("(local reverse tunnel; the Worker cannot see this URL)");
  } else if (detected) {
    console.log(`(detected from ${detected.source})`);
  }
  if (connection.environmentId) {
    console.log("");
    console.log("Environment:");
    console.log(connection.environmentId);
  }
  if (!connection.acceptWebhooks) {
    console.log("");
    console.log("Webhooks: denied (this subscriber)");
  }
  if (control) {
    console.log("");
    console.log("Control:");
    console.log(`${control.url}/ready`);
    console.log(
      "GET /ready returns 503 with a connection-state reason until the WebSocket is live."
    );
  }
  console.log("");
  console.log("Press Ctrl+C to disconnect.");

  try {
    await connection.whenReady();
  } catch (error) {
    await control?.close();
    await connection.disconnect();
    throw error;
  }

  console.log("");
  console.log(
    connection.transport === "tunnel"
      ? "Dev router connected (reverse tunnel)"
      : "Dev router connected"
  );
  console.log("");
  console.log("Replica mode: this environment is subscribed, not yet provider-ready.");
  console.log("Next step: complete the app's OAuth to the third-party provider in this");
  console.log("environment. Use the Public URL as the redirect URI. Tokens stay here;");
  console.log("a new orb must OAuth again before webhook follow-up will work.");
  if (control) {
    console.log("Bind OAuth state from the app process: POST /oauth-states on the Control URL.");
  }
  if (!connection.acceptWebhooks) {
    console.log("Webhooks: denied (this subscriber)");
  }

  await waitForShutdownSignal();
  await control?.close();
  await connection.disconnect();
}

async function printRouteToken(secret: string | undefined, routeId: string): Promise<void> {
  if (!secret) {
    console.error("Missing DEV_ROUTER_SECRET / --secret (operator secret).");
    process.exit(1);
  }
  if (!isAllowedRouteId(routeId)) {
    console.error("Pass --route (or DEV_ROUTER_ROUTE) to mint a route credential.");
    process.exit(1);
  }
  const token = await deriveRouteSecret(secret, routeId);
  console.log(token);
}

function printUsage(): void {
  console.log(`Usage:
  npx dev-router connect --local-url http://127.0.0.1:3000
  npx dev-router connect --route nomads --local-url http://127.0.0.1:3000
  npx dev-router connect --route my-web-app --port 3000
  npx dev-router connect --target https://abc123.cloud-dev.example
  npx dev-router connect --local-url http://127.0.0.1:3000 --no-webhooks
  npx dev-router token
  npx dev-router token --route nomads

Reverse tunnel (--local-url) is the default for private cloud environments
such as Amp orbs, Codespaces, Cursor, CI workers, and containers. The sidecar
opens an outbound WebSocket and forwards requests to the local HTTP server.
The loopback control server (default port 8790) listens immediately; GET /ready
returns 503 with a connection-state reason until the WebSocket is live.

Public-target (--target / PUBLIC_DEV_URL) remains available when the
environment already has a public https:// origin the Worker can fetch.

--route is optional. Omitting it publishes at the router root
(https://dev-webhooks.example.com/*) with no project prefix.
--no-webhooks (or DEV_ROUTER_NO_WEBHOOKS=1) keeps this subscriber on the route
for OAuth but skips webhook fan-out.

Mint credentials from the operator secret. Match the connect command:
  npx dev-router token                 root-scoped (omit --route on connect)
  npx dev-router token --route nomads  named-route only

Environment:
  DEV_ROUTER_URL              Shared router base URL
  DEV_ROUTER_SECRET           Operator secret or minted route credential
  DEV_ROUTER_ROUTE            Optional public path prefix for this project
  DEV_ROUTER_PORT             Local app port used when constructing a detected URL (default 3000)
  DEV_ROUTER_LOCAL_URL        Local HTTP origin for reverse-tunnel mode
  DEV_ROUTER_ENVIRONMENT_ID   Stable identity across reconnects
  DEV_ROUTER_NO_WEBHOOKS      1/true/yes: this subscriber skips webhook fan-out
  DEV_ROUTER_CONTROL_PORT     Loopback control port (default 8790; listens immediately)
  DEV_ROUTER_CONTROL_SOCKET   Unix socket path instead of a TCP port
  DEV_ROUTER_CONTROL_TOKEN    Optional bearer token for the control server
  PUBLIC_DEV_URL              Optional public https:// origin (public-target transport)`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
