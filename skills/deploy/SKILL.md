---
name: deploy
description: >
  Use when deploying or configuring the shared @powerboard/dev-router Cloudflare
  Worker from this repository: wrangler deploy, wrangler types,
  DEV_ROUTER_SECRET, DEV_ROUTER_DASHBOARD_PASSWORD, .dev.vars, durable object bindings ROUTE and ROUTER_INDEX,
  reverse-tunnel WebSockets, /dashboard, custom hostnames, or local wrangler
  dev. The npm package is the client only. Do not load this for client connect
  or request-forwarding behavior.
metadata:
  purpose: Guidance for deploying and operating the shared ingress Worker.
  type: lifecycle
  library: "@powerboard/dev-router"
  library_version: "0.3.4"
sources:
  - shansmith01/wrangle-webhooks:skills/deploy/deploy.md
  - shansmith01/wrangle-webhooks:wrangler.jsonc
  - shansmith01/wrangle-webhooks:src/worker.ts
  - shansmith01/wrangle-webhooks:src/dashboard.ts
  - shansmith01/wrangle-webhooks:src/auth.ts
  - shansmith01/wrangle-webhooks:src/credentials.ts
---

# Deploy the shared router

Deploy one Worker from this repository. Point every client at that origin with `DEV_ROUTER_URL`. The published npm package does not include a deploy step.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler types
npx wrangler deploy
npx wrangler secret put DEV_ROUTER_SECRET
npx wrangler secret put DEV_ROUTER_DASHBOARD_PASSWORD
```

Bind a hostname such as `dev-webhooks.example.com` in the Cloudflare dashboard. Management join routes accept the operator secret or a minted route credential. Subscriber bind/heartbeat/DELETE accept the operator secret or that connection’s token. Tunnel upgrades may use the `dev-router.v1.` WebSocket subprotocol. Remote environments must reach this origin over HTTPS and WSS. The Worker fetches public-target `https://` origins; reverse-tunnel subscribers use the client’s outbound WebSocket. Mint route credentials with `npx dev-router token` (root) or `npx dev-router token --route <id>` (named) and give orbs that matching value, not the operator secret.

## Core Patterns

### Local Worker

```bash
npx wrangler types
npm test
npx wrangler dev
```

Keep secrets in `.dev.vars` locally. Do not commit them.

### Bindings and types

`wrangler.jsonc` binds `ROUTE` (`RouteDurableObject`) and `ROUTER_INDEX` (`RouterIndex`) as SQLite Durable Objects, with `nodejs_compat` and observability enabled. After binding changes, run `npx wrangler types`. Do not hand-write `Env`.

### Dashboard

`GET /dashboard` is a password form that sets an HttpOnly `SameSite=Strict` cookie with `Path=/dashboard`. JSON is `GET /dashboard/status` (`/dashboard.json` redirects there so the cookie is sent). HTML does not inline subscriber JSON; the page fetches `/dashboard/status` and is served with CSP `default-src 'none'` (inline style/script, `connect-src 'self'`). They list active routes, subscriber counts, transport, and environment id. They do not return `DEV_ROUTER_SECRET`, route credentials, connection tokens, or per-connection forward tokens.

## Common Mistakes

### CRITICAL Committing or hardcoding DEV_ROUTER_SECRET

Wrong:

```jsonc
{ "vars": { "DEV_ROUTER_SECRET": "super-secret" } }
```

Correct: `npx wrangler secret put DEV_ROUTER_SECRET` and `npx wrangler secret put DEV_ROUTER_DASHBOARD_PASSWORD` in production; `.dev.vars` locally (gitignored). Mint matching client credentials with `npx dev-router token` (root) or `npx dev-router token --route nomads`. Do not put the operator secret on every orb.

Source: `skills/deploy/deploy.md`, `.gitignore`

### HIGH Skipping wrangler types after binding edits

Wrong: editing a handwritten `Env` interface when adding Durable Object bindings.

Correct: `npx wrangler types` so `worker-configuration.d.ts` matches `wrangler.jsonc`.

Source: `wrangler.jsonc`

### HIGH Gating /dashboard with the management bearer token

Wrong: assuming `/dashboard` is public, or that `Authorization: Bearer <DEV_ROUTER_SECRET>` unlocks it.

Correct: `/dashboard` uses a `Path=/dashboard` session cookie after posting `DEV_ROUTER_DASHBOARD_PASSWORD` to `/dashboard/login`. `/_router/*` join is bearer-protected (operator or route credential) with a timing-safe compare. Subscriber mutations need the operator secret or that connection’s token.

Source: `src/worker.ts`, `src/auth.ts`, `src/credentials.ts`

## Completion

`wrangler deploy` succeeds, `DEV_ROUTER_SECRET` and `DEV_ROUTER_DASHBOARD_PASSWORD` are set, and `GET https://<host>/dashboard` shows a password form. Mint a route credential for each connect style (`npx dev-router token` for root, `npx dev-router token --route nomads` for a named prefix) and give that to clients. Load `connect` for subscriber registration in remote cloud environments.
