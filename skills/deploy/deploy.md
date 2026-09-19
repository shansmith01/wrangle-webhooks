# Deploy the shared router

Deploy the Worker once from **this GitHub repository**. The npm package `@powerboard/dev-router` is the client only; it does not deploy the Worker. Install that client in each project that needs a stable public URL. Bind a **Custom Domain** such as `dev-webhooks.example.com` on a Cloudflare zone (not only `*.workers.dev`). Every remote environment then sets `DEV_ROUTER_URL` to that origin. Zone WAF custom rules and Bot Fight Mode can block scanner probes (`*.php`, `/credentials.json`, `/.env`) before the Worker runs. The Worker also cheap-rejects those paths (no Durable Object, no inbound log) so `workers.dev` and missed WAF rules still do not fan them out.

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
- `ROUTER_INDEX` → `RouterIndex` (active route ids, inbound request metadata, OAuth callback allowlist, webhook fan-out filters, and the historical connection audit log for `/dashboard`)

After changing bindings, regenerate types with `npx wrangler types`. Do not hand-write `Env`.

## Local development of this repository

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler types
npm test
npx wrangler dev
```

The dashboard is password-gated HTML at `/dashboard` and JSON at `/dashboard/status`. Sign-in is `POST /dashboard/login` with `DEV_ROUTER_DASHBOARD_PASSWORD`; that sets an HttpOnly `SameSite=Strict` cookie with `Path=/dashboard` so it is not sent on webhook or OAuth paths. `/dashboard.json` redirects to `/dashboard/status`. HTML does not embed subscriber JSON in a script tag; the page fetches `/dashboard/status` and is served with `Content-Security-Policy` `default-src 'none'` (inline style/script, `connect-src 'self'`). The dashboard lists live routes, subscriber counts, transport (`public` or `tunnel`), environment id, and whether that sidecar opted out of webhooks; OAuth callback path allowlist; webhook fan-out filters (route deny-all checkbox, skip/only remaining-path prefix rules); an inbound request stream (method, route, path without query, public status, subscriber count, delivered count, body size); and a connection history audit log of connects, disconnects, and rejected joins (with `CF-Connecting-IP` when Cloudflare provides it). Inbound rows are metadata only: no bodies, query strings, or headers. Inbound history is kept for 7 days, capped at 5,000 events. Connection history survives disconnects for 90 days, capped at 2,000 events. It does not expose `DEV_ROUTER_SECRET`, route credentials, connection tokens, or per-connection forward tokens.
