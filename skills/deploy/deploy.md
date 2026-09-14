# Deploy the shared router

Deploy the Worker once from **this GitHub repository**. The npm package `@powerboard/dev-router` is the client only; it does not deploy the Worker. Install that client in each project that needs a stable public URL. Bind a hostname such as `dev-webhooks.example.com` to the Worker in the Cloudflare dashboard. Every remote environment then sets `DEV_ROUTER_URL` to that origin.

Subscribers must be able to reach this origin over HTTPS (public-target register/heartbeat) and WSS (reverse tunnel). Allowlist this hostname in locked-down Cloud Agent / VPC egress policies. The Worker fetches public-target `https://` origins; reverse-tunnel subscribers are reached only over the client’s outbound WebSocket.

```bash
npm install
cp .dev.vars.example .dev.vars   # local secrets only
npx wrangler types
npx wrangler deploy
npx wrangler secret put DEV_ROUTER_SECRET
npx wrangler secret put DEV_ROUTER_DASHBOARD_PASSWORD
```

Management endpoints under `/_router/*` require a bearer credential. Store the **operator** secret as the Worker secret `DEV_ROUTER_SECRET`. Join (register / tunnel) also accepts a **route** credential derived from that operator secret. Mint a root-scoped credential with `npx dev-router token` (or `GET /_router/credential`) when clients omit `--route`. Mint a named-route credential with `npx dev-router token --route nomads` (or `GET /_router/routes/nomads/credential`). Give orbs only the matching value. Subscriber heartbeat, OAuth bind, and DELETE require the operator secret or the per-connection token returned at connect — a route credential cannot bind or remove another replica. Tunnel upgrades may send the join credential as a `dev-router.v1.` WebSocket subprotocol. Do not commit `.dev.vars`.

`wrangler.jsonc` names the Worker `dev-router`, enables `nodejs_compat` and observability, and binds two SQLite Durable Objects:

- `ROUTE` → `RouteDurableObject` (per-route subscribers, hibernatable tunnel WebSockets, OAuth `state` bindings)
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

The dashboard is password-gated HTML at `/dashboard` and JSON at `/dashboard/status`. Sign-in is `POST /dashboard/login` with `DEV_ROUTER_DASHBOARD_PASSWORD`; that sets an HttpOnly `SameSite=Strict` cookie with `Path=/dashboard` so it is not sent on webhook or OAuth paths. `/dashboard.json` redirects to `/dashboard/status`. The dashboard lists active routes, subscriber counts, transport (`public` or `tunnel`), and environment id. It does not expose `DEV_ROUTER_SECRET`, route credentials, connection tokens, or per-connection forward tokens.
