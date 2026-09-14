---
name: deploy
description: >
  Use when deploying or configuring the shared @powerboard/dev-router Cloudflare
  Worker from this repository: wrangler deploy, wrangler types,
  DEV_ROUTER_SECRET, .dev.vars, durable object bindings ROUTE and ROUTER_INDEX,
  reverse-tunnel WebSockets, /dashboard, custom hostnames, or local wrangler
  dev. The npm package is the client only. Do not load this for client connect
  or request-forwarding behavior.
metadata:
  purpose: Guidance for deploying and operating the shared ingress Worker.
  type: lifecycle
  library: "@powerboard/dev-router"
  library_version: "0.3.0"
sources:
  - shansmith01/wrangle-webhooks:skills/deploy/deploy.md
  - shansmith01/wrangle-webhooks:wrangler.jsonc
  - shansmith01/wrangle-webhooks:src/worker.ts
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
```

Bind a hostname such as `dev-webhooks.example.com` in the Cloudflare dashboard. Management join routes accept the operator secret or a minted route credential. Subscriber bind/heartbeat/DELETE accept the operator secret or that connection’s token. Tunnel upgrades may use the `dev-router.v1.` WebSocket subprotocol. Remote environments must reach this origin over HTTPS and WSS. The Worker fetches public-target `https://` origins; reverse-tunnel subscribers use the client’s outbound WebSocket. Mint route credentials with `npx dev-router token --route <id>` and give orbs that value, not the operator secret.

## Core Patterns

### Local Worker

```bash
npx wrangler types
npm test
npx wrangler dev
```

Keep the secret in `.dev.vars` locally. Do not commit it.

### Bindings and types

`wrangler.jsonc` binds `ROUTE` (`RouteDurableObject`) and `ROUTER_INDEX` (`RouterIndex`) as SQLite Durable Objects, with `nodejs_compat` and observability enabled. After binding changes, run `npx wrangler types`. Do not hand-write `Env`.

### Dashboard

`GET /dashboard` and `GET /dashboard.json` are public status surfaces. They list active routes, subscriber counts, and transport. They do not return `DEV_ROUTER_SECRET`, route credentials, connection tokens, or per-connection forward tokens.

## Common Mistakes

### CRITICAL Committing or hardcoding DEV_ROUTER_SECRET

Wrong:

```jsonc
{ "vars": { "DEV_ROUTER_SECRET": "super-secret" } }
```

Correct: `npx wrangler secret put DEV_ROUTER_SECRET` in production; `.dev.vars` locally (gitignored). Mint per-route client credentials with `npx dev-router token --route nomads`. Do not put the operator secret on every orb.

Source: `skills/deploy/deploy.md`, `.gitignore`

### HIGH Skipping wrangler types after binding edits

Wrong: editing a handwritten `Env` interface when adding Durable Object bindings.

Correct: `npx wrangler types` so `worker-configuration.d.ts` matches `wrangler.jsonc`.

Source: `wrangler.jsonc`

### HIGH Treating /dashboard as a private admin API

Wrong: assuming `/dashboard` is gated by the management bearer token.

Correct: `/_router/*` join is bearer-protected (operator or route credential) with a timing-safe compare. Subscriber mutations need the operator secret or that connection’s token. `/dashboard` is public status HTML/JSON.

Source: `src/worker.ts`, `src/auth.ts`, `src/credentials.ts`

## Completion

`wrangler deploy` succeeds, `DEV_ROUTER_SECRET` is set, and `GET https://<host>/dashboard` renders. Mint a route credential for each project (`npx dev-router token --route nomads`) and give that to clients. Load `connect` for subscriber registration in remote cloud environments.
