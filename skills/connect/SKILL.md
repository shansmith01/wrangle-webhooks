---
name: connect
description: >
  Use when connecting a remote cloud development environment or a local
  Portless session to @powerboard/dev-router via `npx dev-router connect`,
  DevRouterClient, DEV_ROUTER_URL, DEV_ROUTER_SECRET, DEV_ROUTER_ROUTE, --route,
  --local-url, DEV_ROUTER_LOCAL_URL, --target, PUBLIC_DEV_URL, --environment-id,
  DEV_ROUTER_ENVIRONMENT_ID, control server /ready /oauth-states, Amp orbs,
  Cursor Cloud Agents, Codespaces, Gitpod, Replit, CI workers, containers, or
  local development with Portless. Covers reverse-tunnel sidecar install,
  supervisor .env loading, stable environment ids, optional public HTTPS
  targets, replica mode OAuth, and binding app-generated OAuth state through
  the loopback control server. Load forwarding for the public request contract;
  load deploy to provision the shared Worker.
metadata:
  purpose: Guidance for registering a cloud environment as a router subscriber using the CLI or DevRouterClient.
  type: core
  library: "@powerboard/dev-router"
  library_version: "0.3.3"
sources:
  - shansmith01/wrangle-webhooks:skills/connect/connect.md
  - shansmith01/wrangle-webhooks:src/cli.ts
  - shansmith01/wrangle-webhooks:src/client.ts
  - shansmith01/wrangle-webhooks:src/tunnel-client.ts
  - shansmith01/wrangle-webhooks:src/control-server.ts
  - shansmith01/wrangle-webhooks:src/connection-state.ts
  - shansmith01/wrangle-webhooks:src/credentials.ts
  - shansmith01/wrangle-webhooks:src/detect-url.ts
  - shansmith01/wrangle-webhooks:src/shared.ts
---

# Connect a cloud environment

Register the current environment with the shared ingress Worker. Keep the client as a sidecar next to the app process. Prefer reverse tunnel (`--local-url`) so private environments do not need a public HTTPS origin. Public-target (`--target`) is optional when Cloudflare can already `fetch()` the app.

## Setup

```bash
npm install -D @powerboard/dev-router
export DEV_ROUTER_URL=https://dev-webhooks.example.com
export DEV_ROUTER_SECRET=<minted credential>
npx dev-router connect --local-url http://127.0.0.1:3000 --environment-id "$AMP_THREAD_ID"
```

```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:app\" \"dev-router connect --local-url http://127.0.0.1:3000\""
  }
}
```

Programmatic equivalent:

```ts
import { DevRouterClient } from "@powerboard/dev-router";

const client = new DevRouterClient({
  routerUrl: process.env.DEV_ROUTER_URL!,
  secret: process.env.DEV_ROUTER_SECRET!
});
const connection = await client.connect({
  routeId: "nomads",
  localUrl: "http://127.0.0.1:3000",
  environmentId: process.env.DEV_ROUTER_ENVIRONMENT_ID
});
await connection.disconnect();
```

One-shot: `npx --yes @powerboard/dev-router connect --local-url http://127.0.0.1:3000`. Do not run unscoped `npx dev-router` unless this package is already installed.

## Core Patterns

### Reverse tunnel to a local HTTP server

```bash
npx dev-router connect --local-url http://127.0.0.1:3000 --environment-id "$AMP_THREAD_ID"
```

The sidecar opens an outbound WebSocket, forwards each request to `localUrl`, and returns status/headers/body. Amp, Codespaces, Cursor, CI, containers, and private VMs use this same local URL interface. Pass a stable `--environment-id` so reconnects keep the subscriber and pending OAuth bindings. Omit `--route` for root URLs (`https://dev-webhooks.example.com/oauth/callback`); pass `--route nomads` when the project needs a prefix.

### Amp `.amp/services.yaml` (root route + direct `/ready`)

```yaml
services:
  app:
    command: npm run dev -- --host 0.0.0.0 --port "$PORT"
    port: 3000
    portal: true
  router:
    command: >-
      npx dev-router connect
      --local-url http://127.0.0.1:3000
      --environment-id "$AMP_THREAD_ID"
      --control-port "$PORT"
    port: 8790
    health: /ready
```

Amp injects `PORT` and `AMP_THREAD_ID`. `health: /ready` probes the sidecar control server (503 until the WebSocket is live; `reason` is `connecting`, `unauthorized`, or `network_error`). Mint `npx dev-router token` for this root connect; mint `npx dev-router token --route nomads` only when the command also has `--route nomads`.

### Local development with Portless

Portless assigns `PORT` only inside its child process. Start the API and the sidecar from that child:

```bash
dev-router connect --local-url "http://127.0.0.1:${PORT}" --environment-id "$DEV_ROUTER_ENVIRONMENT_ID"
```

Load `.env` into the **supervising shell** before it checks `DEV_ROUTER_URL` or `DEV_ROUTER_SECRET`. Bun can load `.env` for the application without exporting those values to the supervisor.

Do not `source .env`. Values can contain spaces and shell characters. Use a dotenv parser. Accept readable `.env` sources, including named pipes (`test -r`, not `test -f`). Report secret **presence** only. Never `set -x`, print the environment, or show credential values.

```bash
# macOS Bash 3.2. test -r allows named pipes; test -f does not.
if [ -r .env ]; then
  eval "$(ENV_FILE=.env node -e '
const fs = require("fs");
for (const raw of fs.readFileSync(process.env.ENV_FILE, "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const body = line.startsWith("export ") ? line.slice(7).trim() : line;
  const eq = body.indexOf("=");
  if (eq <= 0) continue;
  const key = body.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
  let value = body.slice(eq + 1).trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'\''") && value.endsWith("'\''"))) {
    value = value.slice(1, -1);
  }
  process.stdout.write("export " + key + "=" + JSON.stringify(value) + "\n");
}
')"
fi
if [ -n "${DEV_ROUTER_SECRET:-}" ]; then echo "DEV_ROUTER_SECRET is set"; else echo "DEV_ROUTER_SECRET is missing"; fi
```

Verify the executable, not only the package listing:

```bash
bun pm ls @powerboard/dev-router
test -x node_modules/.bin/dev-router
```

Use a stable local environment id. Do not use a PID — PIDs change after restart and create parked stale subscribers.

```bash
host=$(hostname -s | tr "[:upper:]" "[:lower:]" | sed "s/[^A-Za-z0-9._~:@+-]/-/g")
path_hash=$(printf "%s" "$PWD" | shasum -a 256 | cut -c1-12)
export DEV_ROUTER_ENVIRONMENT_ID="local-${host}-${path_hash}"
```

`--environment-id` is at most 128 characters and only `A-Z a-z 0-9 . _ ~ : @ + -`.

The control server listens immediately. `GET /ready` returns 503 with a safe `reason` (`connecting`, `unauthorized`, `network_error`) until the WebSocket is live. Port 8790 closed means the sidecar process is not running. A running sidecar with 503 `unauthorized` is rejected authentication, not a missing process. On package versions before 0.3.3, 8790 opened only after the WebSocket succeeded, so a running sidecar with no listener could also mean 401 or a network problem.

Safe 401 path (do not print secrets or `Authorization` headers):

```bash
curl -sS http://127.0.0.1:8790/ready
# {"ready":false,"reason":"unauthorized",...}
```

The Worker **operator** secret can join any route. A minted **root** credential (`npx dev-router token`) joins only when connect omits `--route`. A minted **named** credential (`npx dev-router token --route nomads`) joins only that route. Mixing them yields WebSocket upgrade 401.

macOS Bash 3.2: empty array expansion under `set -u` terminates the supervisor (`args=(); cmd "${args[@]}"`). Use `${args[@]+"${args[@]}"}` or skip the expansion when `${#args[@]}` is 0.

Ctrl+C must stop the API and sidecar but leave the shared Portless proxy running.

Public HTTP 202 only confirms fan-out acceptance. Require a unique marker in the local API log and a local HTTP 200 before declaring success.

### Bind OAuth state from the app process

The CLI sidecar owns the `Connection`. The API process should not import `DevRouterClient`. After connect, the sidecar listens on loopback:

```http
GET  http://127.0.0.1:8790/ready
POST http://127.0.0.1:8790/oauth-states
{"state":"<app-generated-state>"}
```

Required when another replica is already subscribed to the same route. A lone subscriber is routed automatically. `GET /ready` returns 503 with a safe `reason` until the tunnel WebSocket is connected, not merely because a subscriber id still exists.

### Optional public-target transport

```bash
npx dev-router connect --route my-web-app --target https://abc123.cloud-dev.example
```

Explicit `targetBaseUrl` must be absolute `https://` without credentials or a fragment.

### Correlate OAuth state from the sidecar process

```ts
const state = await connection.wrapOAuthState(appNonce);
await connection.bindOAuthState(appGeneratedState);
```

Use this only in the process that called `connect()`. From the app, POST `/oauth-states` on the control server instead.

### Replica mode (prompt after every new environment)

Each orb is a full copy. Connecting the sidecar is not enough. After `connect` succeeds, tell the operator their new environment is ready to subscribe — they still need to complete the app’s OAuth to the third-party provider **in this environment** before webhook follow-up will work. Sidecar first, then OAuth. Tokens stay in this environment; the next orb OAuths again.

## Common Mistakes

### HIGH Treating DevRouterClient as in-process middleware

Wrong:

```ts
import { DevRouterClient } from "@powerboard/dev-router";
// expecting the class to replace the HTTP server
```

Correct: run `dev-router connect` beside the app. Bind OAuth `state` with `POST http://127.0.0.1:8790/oauth-states`. In tunnel mode the sidecar reverse-proxies to `localUrl`. In public-target mode it only registers, heartbeats, and deregisters.

Source: `skills/connect/connect.md`, `src/client.ts`, `src/control-server.ts`

### HIGH Passing localhost as a public target

Wrong:

```ts
await client.connect({ targetBaseUrl: "http://localhost:3000" });
```

Correct:

```ts
await client.connect({ localUrl: "http://127.0.0.1:3000" });
```

`validateTargetBaseUrl` still rejects `http:` for public-target transport. Private environments must use `--local-url`.

Source: `src/shared.ts`, `skills/connect/connect.md`

### HIGH Looking up the public npm name `dev-router`

Wrong:

```bash
npx dev-router connect
```

in a project that has not installed `@powerboard/dev-router`.

Correct: `npm install -D @powerboard/dev-router` first, or `npx --yes @powerboard/dev-router connect`.

Source: `skills/connect/connect.md`

### HIGH Giving every orb the operator secret

Wrong: setting `DEV_ROUTER_SECRET` on replicas to the Worker operator secret.

Correct: `npx dev-router token` (root) or `npx dev-router token --route nomads` (named). Give orbs that matching credential. The operator secret can join any route and act as any subscriber.

Source: `src/credentials.ts`, `skills/connect/connect.md`

### MEDIUM Using a reserved route prefix

Wrong:

```ts
await client.connect({ routeId: "dashboard", localUrl: "http://127.0.0.1:3000" });
```

Correct: omit `--route` for root ingress (mint with `npx dev-router token`), or pick an unreserved id such as `nomads` (mint with `npx dev-router token --route nomads`). `_router` and `dashboard` are reserved.

Source: `src/shared.ts`

### HIGH Treating GET /ready as connected because a subscriber id exists

Wrong: treating `/ready` as 200 during reconnect just because `--environment-id` parked a subscriber id.

Correct: `/ready` returns 503 with `reason` `connecting`, `unauthorized`, or `network_error` until the live WebSocket is connected. Amp `health: /ready` should fail while the sidecar is backing off. A closed port 8790 means the process is not listening; `unauthorized` means the join credential was rejected.

Source: `src/control-server.ts`, `src/tunnel-client.ts`

### HIGH Using a PID as --environment-id

Wrong: `--environment-id "local-$$"` or any per-process id.

Correct: `local-<sanitized-hostname>-<checkout-path-hash>`. PIDs change after restart and park stale subscribers. Max 128 characters; only `A-Za-z0-9._~:@+-`.

Source: `src/shared.ts`

### HIGH Sourcing .env in the supervisor

Wrong: `set -x; source .env` or `test -f .env`.

Correct: parse `.env` with a dotenv reader after `test -r` (named pipes are readable, not regular files). Report whether `DEV_ROUTER_SECRET` is set; never print its value.

Source: `skills/connect/connect.md`

### HIGH Declaring Portless success from a public 202

Wrong: treating the Worker’s webhook `202` as proof the local API handled the request.

Correct: require a unique marker in the local API log and a local HTTP 200. Public 202 only confirms fan-out acceptance.

Source: `skills/forwarding/forwarding.md`, `src/worker.ts`

### HIGH Declaring a new environment ready without OAuth

Wrong: after `dev-router connect`, telling the operator that webhooks will just work.

Correct: prompt them to OAuth-register this replica with the third-party provider (sidecar already up, Public URL as redirect URI). Until this environment has tokens, it should not be treated as a webhook replica.

Source: `skills/connect/connect.md`

## Completion

The CLI prints `Public:`, `Forwarding to:`, and `Control:` as soon as the control server binds (8790 listens before the WebSocket is up). Tunnel mode prints that the local URL is not visible to the Worker. SIGINT/SIGTERM closes the WebSocket and then DELETE. Anonymous tunnel subscribers are removed immediately; `--environment-id` parks the subscriber so OAuth bindings survive a reconnect. On a Portless laptop, Ctrl+C must stop the API and sidecar but leave the shared Portless proxy running.

Do not stop at “connected.” Tell the operator, in substance:

**Your new environment is subscribed. Next, complete the app’s OAuth to the third-party provider in this environment** (the replica-mode register step). Use the printed Public URL as the redirect URI. If other orbs are already on this route, the app must POST `/oauth-states` on the Control URL (or wrap/bind `state` from the sidecar) so this orb owns the callback. Tokens stay here; a new orb must OAuth again. Webhook fan-out is only worthwhile for replicas that have finished that OAuth.
