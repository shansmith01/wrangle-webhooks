---
name: connect
description: >
  Use when connecting a cloud development environment to @wrangle/dev-router
  via `npx dev-router connect`, DEV_ROUTER_URL, DEV_ROUTER_SECRET,
  DEV_ROUTER_ROUTE, --route, --target, PUBLIC_DEV_URL, or DevRouterClient.
  Covers sidecar install, URL detection, HTTPS target rules, and optional
  route prefixes. Load forwarding for the public request contract; load
  deploy to provision the shared Worker.
metadata:
  purpose: Guidance for registering a cloud environment as a router subscriber using the CLI or DevRouterClient.
  type: core
  library: "@wrangle/dev-router"
  library_version: "0.1.0"
sources:
  - shansmith01/wrangle-webhooks:skills/connect/connect.md
  - shansmith01/wrangle-webhooks:src/cli.ts
  - shansmith01/wrangle-webhooks:src/client.ts
  - shansmith01/wrangle-webhooks:src/detect-url.ts
  - shansmith01/wrangle-webhooks:src/shared.ts
---

# Connect a cloud environment

Register the current environment with the shared ingress Worker. Keep the client as a sidecar next to the app process.

## Setup

```bash
npm install -D github:shansmith01/wrangle-webhooks
export DEV_ROUTER_URL=https://dev-router.example.workers.dev
export DEV_ROUTER_SECRET=<secret>
npx dev-router connect
```

```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:app\" \"dev-router connect\""
  }
}
```

Programmatic equivalent:

```ts
import { DevRouterClient } from "@wrangle/dev-router";

const client = new DevRouterClient({
  routerUrl: process.env.DEV_ROUTER_URL!,
  secret: process.env.DEV_ROUTER_SECRET!
});
const connection = await client.connect();
await connection.disconnect();
```

## Core Patterns

### Publish at the router root

Omit `--route` / `routeId` (or pass `""`) so traffic is accepted at `https://<router>/*`.

### Add a project prefix

```bash
npx dev-router connect --route my-web-app
```

`routeId` must match `^[A-Za-z0-9._~-]+$` and must not be `_router` or `dashboard`.

### Override a wrong detected URL

Detection uses VS Code port forwarding, GitHub Codespaces, Gitpod, then Replit. Port comes from `--port`, `DEV_ROUTER_PORT`, `PORT`, then `3000`.

```bash
npx dev-router connect --port 5173 --target https://abc123.cloud-dev.example
```

Explicit `targetBaseUrl` must be absolute `https://` without credentials or a fragment. A base path is allowed.

### GitHub install of the binary

After `npm install github:shansmith01/wrangle-webhooks`, run `npx dev-router connect`. Do not run `npx --yes github:shansmith01/wrangle-webhooks dev-router connect` — the extra `dev-router` is treated as a command name, not the package.

## Common Mistakes

### HIGH Treating the client as request runtime

Wrong:

```ts
import { DevRouterClient } from "@wrangle/dev-router";
// expecting the client to receive or proxy HTTP
```

Correct: run `dev-router connect` beside the app. The Worker fans out to `targetBaseUrl`. The npm client only registers, heartbeats every 60s, and deregisters.

Source: `skills/connect/connect.md`, `src/client.ts`

### HIGH Passing http:// or credentialed target URLs

Wrong:

```ts
await client.connect({ targetBaseUrl: "http://localhost:3000" });
```

Correct:

```ts
await client.connect({
  targetBaseUrl: "https://abc123.cloud-dev.example"
});
```

`validateTargetBaseUrl` rejects `http:`, username/password, and fragments.

Source: `src/shared.ts`

### HIGH Looking up the public npm name `dev-router`

Wrong:

```bash
npx dev-router connect
```

in a project that has not installed `@wrangle/dev-router`.

Correct: `npm install -D github:shansmith01/wrangle-webhooks` first, or `npx --yes github:shansmith01/wrangle-webhooks connect`.

Source: `skills/connect/connect.md`

### MEDIUM Using a reserved route prefix

Wrong:

```bash
npx dev-router connect --route dashboard
```

Correct: omit `--route` for root ingress, or pick an unreserved id such as `my-web-app`. `_router` and `dashboard` are reserved.

Source: `src/shared.ts`

## Completion

The CLI prints `Public:` (`https://<router>/*` or `https://<router>/<routeId>/*`) and `Forwarding to:`. Heartbeats keep the subscriber alive for 5 minutes of silence. On SIGINT/SIGTERM the client deregisters; TTL covers a failed DELETE.

When implementing the app that receives forwarded HTTP, load `forwarding`. When provisioning the Worker, load `deploy`.
