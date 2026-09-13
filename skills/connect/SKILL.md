---
name: connect
description: >
  Use when connecting a remote cloud development environment to
  @wrangle/dev-router via `npx dev-router connect`, DevRouterClient,
  DEV_ROUTER_URL, DEV_ROUTER_SECRET, DEV_ROUTER_ROUTE, --route, --target,
  PUBLIC_DEV_URL, Cursor Cloud Agents, Codespaces, Gitpod, Replit, VS Code
  tunnels, or cloudflared. Covers sidecar install, public HTTPS target rules,
  and why localhost port-forward is not a Worker target. Load forwarding for
  the public request contract; load deploy to provision the shared Worker.
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

Register the current environment with the shared ingress Worker. Keep the client as a sidecar next to the app process. The Worker must `fetch()` `targetBaseUrl` from Cloudflare, so the target is a public `https://` origin — not `localhost` and not an IDE-only port-forward.

## Setup

```bash
npm install -D @wrangle/dev-router
export DEV_ROUTER_URL=https://dev-webhooks.example.com
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

One-shot: `npx --yes @wrangle/dev-router connect`. Do not run unscoped `npx dev-router` unless this package is already installed.

## Core Patterns

### Publish at the router root

Omit `--route` / `routeId` (or pass `""`) so traffic is accepted at `https://<router>/*`.

### Add a project prefix

```bash
npx dev-router connect --route my-web-app
```

`routeId` must match `^[A-Za-z0-9._~-]+$` and must not be `_router` or `dashboard`.

### Remote cloud environment (Codespaces, Cloud Agents, VMs)

Run the sidecar **in** the environment that serves the app. Bind the app to `0.0.0.0` plus `--port` / `DEV_ROUTER_PORT` / `PORT` (default `3000`).

Detection order: `VSCODE_PROXY_URI`, GitHub Codespaces, Gitpod, Replit. Codespaces ports must be **public**.

**Cursor Cloud Agents** (and hosts with no detector) do not expose a Worker-reachable URL via laptop port-forward. Publish HTTPS ingress (public platform port or `cloudflared tunnel --url http://127.0.0.1:<port>`), set `PUBLIC_DEV_URL` / `--target`, and store `DEV_ROUTER_URL` + `DEV_ROUTER_SECRET` as agent secrets. Allowlist the Worker host if egress is restricted.

If nothing is detected, the CLI registers `https://dev-router-test.example` — that target will not receive traffic.

### Override a wrong or missing URL

```bash
npx dev-router connect --port 5173 --target https://abc123.cloud-dev.example
```

Explicit `targetBaseUrl` must be absolute `https://` without credentials or a fragment. A base path is allowed.

## Common Mistakes

### HIGH Treating the client as request runtime

Wrong:

```ts
import { DevRouterClient } from "@wrangle/dev-router";
// expecting the client to receive or proxy HTTP
```

Correct: run `dev-router connect` beside the app. The Worker fans out to `targetBaseUrl`. The npm client only registers, heartbeats every 60s, and deregisters.

Source: `skills/connect/connect.md`, `src/client.ts`

### HIGH Passing localhost, http://, or IDE-only port-forward targets

Wrong:

```ts
await client.connect({ targetBaseUrl: "http://localhost:3000" });
```

Correct:

```ts
await client.connect({
  targetBaseUrl: "https://abc123.trycloudflare.com"
});
```

`validateTargetBaseUrl` rejects `http:`, username/password, and fragments. Cursor/VS Code preview forwards are not Cloudflare-reachable unless they are public `https://` tunnel or Codespaces URLs.

Source: `src/shared.ts`, `skills/connect/connect.md`

### HIGH Looking up the public npm name `dev-router`

Wrong:

```bash
npx dev-router connect
```

in a project that has not installed `@wrangle/dev-router`.

Correct: `npm install -D @wrangle/dev-router` first, or `npx --yes @wrangle/dev-router connect`.

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
