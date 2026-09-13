# Cloud Dev Ingress Router

Shared Cloudflare ingress for ephemeral cloud development environments. Deploy the Worker once, then install the npm client in any project that needs a stable public URL.

```text
External service
      |
      v
https://dev-webhooks.example.com/<routeId>/<any-path>
      |
      v
Shared Cloudflare Worker + Durable Object
      |
      +--> Dev Environment A
      +--> Dev Environment B
```

The router is generic. It does not distinguish webhooks, OAuth callbacks, or any other HTTP request. Everything after `routeId` is forwarded as-is.

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

```bash
npm install -D @wrangle/dev-router
```

```bash
export DEV_ROUTER_URL=https://dev-webhooks.example.com
export DEV_ROUTER_SECRET=<secret>
export DEV_ROUTER_ROUTE=my-web-app
export PUBLIC_DEV_URL=https://abc123.cloud-dev.example

npx dev-router connect
```

Optional flags:

```bash
npx dev-router connect \
  --route my-web-app \
  --target https://abc123.cloud-dev.example
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

const connection = await client.connect({
  routeId: "my-web-app",
  targetBaseUrl: process.env.PUBLIC_DEV_URL!
});

await connection.disconnect();
```

`targetBaseUrl` must be `https://`, absolute, and must not include credentials. A base path is allowed (`https://host/dev-ingress`).

## Request contract

Incoming:

```text
POST https://dev-webhooks.example.com/project-a/api/hooks/payment?id=123
```

Forwarded to each active subscriber:

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
