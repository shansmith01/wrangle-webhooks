---
name: deploy
description: >
  Use when deploying or configuring the shared @wrangle/dev-router Cloudflare
  Worker: wrangler deploy, wrangler types, DEV_ROUTER_SECRET, .dev.vars,
  durable object bindings ROUTE and ROUTER_INDEX, /dashboard, or local
  wrangler dev. Do not load this for client connect or request-forwarding
  behavior.
metadata:
  purpose: Guidance for deploying and operating the shared ingress Worker.
  type: lifecycle
  library: "@wrangle/dev-router"
  library_version: "0.1.0"
sources:
  - shansmith01/wrangle-webhooks:skills/deploy/deploy.md
  - shansmith01/wrangle-webhooks:wrangler.jsonc
  - shansmith01/wrangle-webhooks:src/worker.ts
  - shansmith01/wrangle-webhooks:src/auth.ts
---

# Deploy the shared router

Deploy one Worker. Point every client at that origin with `DEV_ROUTER_URL`.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler types
npx wrangler deploy
npx wrangler secret put DEV_ROUTER_SECRET
```

Bind a hostname such as `dev-webhooks.example.com` in the Cloudflare dashboard. Management routes under `/_router/*` require `Authorization: Bearer <secret>`.

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

`GET /dashboard` and `GET /dashboard.json` are public status surfaces. They list active routes and subscriber counts. They do not return `DEV_ROUTER_SECRET`.

## Common Mistakes

### CRITICAL Committing or hardcoding DEV_ROUTER_SECRET

Wrong:

```jsonc
{ "vars": { "DEV_ROUTER_SECRET": "super-secret" } }
```

Correct: `npx wrangler secret put DEV_ROUTER_SECRET` in production; `.dev.vars` locally (gitignored).

Source: `skills/deploy/deploy.md`, `.gitignore`

### HIGH Skipping wrangler types after binding edits

Wrong: editing a handwritten `Env` interface when adding Durable Object bindings.

Correct: `npx wrangler types` so `worker-configuration.d.ts` matches `wrangler.jsonc`.

Source: `wrangler.jsonc`

### HIGH Treating /dashboard as a private admin API

Wrong: assuming `/dashboard` is gated by the management bearer token.

Correct: `/_router/*` is bearer-protected with a timing-safe compare. `/dashboard` is public status HTML/JSON.

Source: `src/worker.ts`, `src/auth.ts`

## Completion

`wrangler deploy` succeeds, `DEV_ROUTER_SECRET` is set, and `GET https://<host>/dashboard` renders. Clients can then `connect`. Load `connect` for subscriber registration.
