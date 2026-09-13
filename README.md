# Cloud Dev Ingress Router

Shared Cloudflare ingress for ephemeral cloud development environments. Deploy the Worker once, then install the npm client in any project that needs a stable public URL.

```text
External service
      |
      v
https://dev-webhooks.example.com[/<routeId>]/<any-path>
      |
      v
Shared Cloudflare Worker + Durable Object
      |
      +--> Dev Environment A
      +--> Dev Environment B
```

The router is generic. It does not distinguish webhooks, OAuth callbacks, or any other HTTP request.

`routeId` is an optional public path prefix, not a private identifier:

- omitted / empty → `https://dev-webhooks.example.com/oauth/callback`
- `my-web-app` → `https://dev-webhooks.example.com/my-web-app/oauth/callback`

If a named route has active subscribers, it wins for that prefix. Otherwise an empty-route subscriber receives the full path.

## Architecture

- **Worker** — public HTTP API and management API under `/_router/*`
- **Durable Object per `routeId`** — subscriber registration, heartbeats, expiry, fan-out coordination
- **npm client** — development sidecar that only registers, heartbeats, and deregisters

Management endpoints require `Authorization: Bearer <secret>`. Store that value as the Worker secret `DEV_ROUTER_SECRET`.

## Deploy the shared service

```bash
npm install
cp .dev.vars.example .dev.vars   # local secret only
npx wrangler types
npx wrangler deploy
npx wrangler secret put DEV_ROUTER_SECRET
```

Bind a hostname such as `dev-webhooks.example.com` to the Worker in the Cloudflare dashboard.

## Use the client in a project

This package is not on the npm registry yet (`npx dev-router` will 404). Install it from GitHub, then run the local binary:

```bash
npm install -D github:shansmith01/wrangle-webhooks
```

```bash
export DEV_ROUTER_URL=https://dev-router.websupport-4ba.workers.dev
export DEV_ROUTER_SECRET=<secret>

npx dev-router connect
```

After the GitHub install, `npx dev-router` uses `node_modules/.bin/dev-router` from this package (`@wrangle/dev-router`). Do not run `npx dev-router` in a project that has not installed it first — npm will look up a public package named `dev-router`.

One-shot without adding a dependency:

```bash
npx --yes github:shansmith01/wrangle-webhooks connect
```

That publishes the environment at the router root (`https://dev-webhooks.example.com/*`). Pass `--route my-web-app` or `DEV_ROUTER_ROUTE` only when you want a project prefix.

`connect` detects the current cloud environment's public URL (GitHub Codespaces, VS Code tunnels, Gitpod, and similar). It uses `DEV_ROUTER_PORT` or `PORT` when the platform URL includes a port, and defaults to `3000`.

Override only when detection is wrong:

```bash
npx dev-router connect --port 5173
npx dev-router connect --target https://abc123.cloud-dev.example
```

Treat the client as a sidecar, not application runtime:

```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:app\" \"dev-router connect\""
  }
}
```

### Programmatic API

```ts
import { DevRouterClient } from "@wrangle/dev-router";

const client = new DevRouterClient({
  routerUrl: process.env.DEV_ROUTER_URL!,
  secret: process.env.DEV_ROUTER_SECRET!
});

const connection = await client.connect();

await connection.disconnect();
```

`routeId` is optional. Omit it (or pass `""`) for root ingress with no project prefix.

`targetBaseUrl` is optional. When omitted, the client detects the environment's public `https://` origin. Explicit values must be absolute HTTPS URLs without credentials. A base path is allowed (`https://host/dev-ingress`).

## Request contract

Incoming with a route prefix:

```text
POST https://dev-webhooks.example.com/project-a/api/hooks/payment?id=123
```

Forwarded:

```text
POST https://dev-a.example/api/hooks/payment?id=123
```

Incoming with an empty route:

```text
POST https://dev-webhooks.example.com/api/hooks/payment?id=123
```

Forwarded:

```text
POST https://dev-a.example/api/hooks/payment?id=123
```

The original method, raw body, query string, and relevant headers are preserved. The public caller receives `202 Accepted` as soon as fan-out is accepted. Subscriber status codes are not propagated.

If a route has no active subscribers, the router returns `404` with `{ "error": "route_not_found" }`.

Heartbeats every 60 seconds keep a subscriber alive. Expiry is 5 minutes. One failed subscriber does not prevent delivery attempts to the others. Each delivery has a 10 second timeout and does not follow redirects.

## Local development of this repository

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler types
npm test
npx wrangler dev
```
