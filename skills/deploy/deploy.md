# Deploy the shared router

Deploy the Worker once. Install the npm client in each project that needs a stable public URL. Bind a hostname such as `dev-webhooks.example.com` to the Worker in the Cloudflare dashboard.

```bash
npm install
cp .dev.vars.example .dev.vars   # local secret only
npx wrangler types
npx wrangler deploy
npx wrangler secret put DEV_ROUTER_SECRET
```

Management endpoints under `/_router/*` require `Authorization: Bearer <secret>`. Store that value as the Worker secret `DEV_ROUTER_SECRET`. Do not commit `.dev.vars`.

`wrangler.jsonc` names the Worker `dev-router`, enables `nodejs_compat` and observability, and binds two SQLite Durable Objects:

- `ROUTE` → `RouteDurableObject` (per-route subscribers)
- `ROUTER_INDEX` → `RouterIndex` (active route ids for `/dashboard`)

After changing bindings, regenerate types with `npx wrangler types`. Do not hand-write `Env`.

## Local development of this repository

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler types
npm test
npx wrangler dev
```

The dashboard is public HTML at `/dashboard` and JSON at `/dashboard.json`. It lists active routes and subscriber counts. It does not expose `DEV_ROUTER_SECRET`.
