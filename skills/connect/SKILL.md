---
name: connect
description: >
  Use when connecting a remote cloud development environment to
  @powerboard/dev-router via `npx dev-router connect`, DevRouterClient,
  DEV_ROUTER_URL, DEV_ROUTER_SECRET, DEV_ROUTER_ROUTE, --route, --local-url,
  DEV_ROUTER_LOCAL_URL, --target, PUBLIC_DEV_URL, --environment-id,
  DEV_ROUTER_ENVIRONMENT_ID, control server /ready /oauth-states, Amp orbs,
  Cursor Cloud Agents, Codespaces, Gitpod, Replit, CI workers, or containers.
  Covers reverse-tunnel sidecar install, optional public HTTPS targets, replica
  mode OAuth, and binding app-generated OAuth state through the loopback control
  server. Load forwarding for the public request contract; load deploy to
  provision the shared Worker.
metadata:
  purpose: Guidance for registering a cloud environment as a router subscriber using the CLI or DevRouterClient.
  type: core
  library: "@powerboard/dev-router"
  library_version: "0.3.0"
sources:
  - shansmith01/wrangle-webhooks:skills/connect/connect.md
  - shansmith01/wrangle-webhooks:src/cli.ts
  - shansmith01/wrangle-webhooks:src/client.ts
  - shansmith01/wrangle-webhooks:src/tunnel-client.ts
  - shansmith01/wrangle-webhooks:src/control-server.ts
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
export DEV_ROUTER_SECRET=<route credential>
npx dev-router connect --route nomads --local-url http://127.0.0.1:3000 --environment-id "$AMP_THREAD_ID"
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
npx dev-router connect --route nomads --local-url http://127.0.0.1:3000 --environment-id "$AMP_THREAD_ID"
```

The sidecar opens an outbound WebSocket, forwards each request to `localUrl`, and returns status/headers/body. Amp, Codespaces, Cursor, CI, containers, and private VMs use this same local URL interface. Pass a stable `--environment-id` so reconnects keep the subscriber and pending OAuth bindings.

### Bind OAuth state from the app process

The CLI sidecar owns the `Connection`. The API process should not import `DevRouterClient`. After connect, the sidecar listens on loopback:

```http
GET  http://127.0.0.1:8790/ready
POST http://127.0.0.1:8790/oauth-states
{"state":"<app-generated-state>"}
```

Required when another replica is already subscribed to the same route. A lone subscriber is routed automatically.

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

Correct: `npx dev-router token --route nomads` and give orbs that route credential. The operator secret can join any route and act as any subscriber.

Source: `src/credentials.ts`, `skills/connect/connect.md`

### MEDIUM Using a reserved route prefix

Wrong:

```ts
await client.connect({ routeId: "dashboard", localUrl: "http://127.0.0.1:3000" });
```

Correct: omit `--route` for root ingress, or pick an unreserved id such as `nomads`. `_router` and `dashboard` are reserved.

Source: `src/shared.ts`

### HIGH Declaring a new environment ready without OAuth

Wrong: after `dev-router connect`, telling the operator that webhooks will just work.

Correct: prompt them to OAuth-register this replica with the third-party provider (sidecar already up, Public URL as redirect URI). Until this environment has tokens, it should not be treated as a webhook replica.

Source: `skills/connect/connect.md`

## Completion

The CLI prints `Public:`, `Forwarding to:`, and `Control:`. Tunnel mode prints that the local URL is not visible to the Worker. SIGINT/SIGTERM closes the WebSocket and then DELETE. Anonymous tunnel subscribers are removed immediately; `--environment-id` parks the subscriber so OAuth bindings survive a reconnect.

Do not stop at “connected.” Tell the operator, in substance:

**Your new environment is subscribed. Next, complete the app’s OAuth to the third-party provider in this environment** (the replica-mode register step). Use the printed Public URL as the redirect URI. If other orbs are already on this route, the app must POST `/oauth-states` on the Control URL (or wrap/bind `state` from the sidecar) so this orb owns the callback. Tokens stay here; a new orb must OAuth again. Webhook fan-out is only worthwhile for replicas that have finished that OAuth.
