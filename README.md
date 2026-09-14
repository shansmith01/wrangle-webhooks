# [@powerboard/dev-router](https://www.npmjs.com/package/@powerboard/dev-router)

[npm](https://www.npmjs.com/package/@powerboard/dev-router)

Shared Cloudflare ingress for ephemeral cloud development environments. Deploy the Worker once, then install the npm client in any project that needs a **stable public URL**.

Webhook providers, OAuth apps, and other external services call the Worker. The default transport is a **reverse tunnel**: the sidecar opens an outbound WebSocket and forwards each request to a local HTTP server. Public-target forwarding remains available for environments that already have a public `https://` origin.

```text
External service
      |
      v
https://dev-webhooks.example.com[/<routeId>]/<any-path>
      |
      v
Shared Cloudflare Worker + Durable Object
      |
      +--> reverse tunnel (WebSocket) --> http://127.0.0.1:3000  (Amp, orbs, CI, VMs)
      +--> optional public https:// origin
```

`routeId` is an optional **public path prefix**, not a private identifier. Omitting `--route` (and `DEV_ROUTER_ROUTE`) publishes at the router root, so provider URLs have no project prefix:

- omit `--route` → `https://dev-webhooks.example.com/oauth/callback`
- `--route my-web-app` → `https://dev-webhooks.example.com/my-web-app/oauth/callback`

If a named route has active subscribers, it wins for that prefix. Otherwise a root subscriber receives the full path.

Mint a join credential that matches how the sidecar will connect. Use the **operator** secret (`DEV_ROUTER_SECRET` on the Worker) only for minting:

| Connect with | Mint with | Public URL |
| --- | --- | --- |
| omit `--route` | `npx dev-router token` | `https://dev-webhooks.example.com/*` |
| `--route nomads` | `npx dev-router token --route nomads` | `https://dev-webhooks.example.com/nomads/*` |

A root-scoped credential cannot join a named route. A named-route credential cannot join root or another route. Give orbs the minted value as `DEV_ROUTER_SECRET`; do not hand every environment the operator secret. The operator can also `GET /_router/credential` (root) or `GET /_router/routes/<routeId>/credential`.

Webhooks fan out to every subscriber. OAuth callbacks are routed to **one** subscriber and that subscriber’s response is returned to the public caller.

## Two packages of work

| Role | What you use | Install |
| --- | --- | --- |
| **App / cloud environment** | Sidecar CLI and `DevRouterClient` | [`npm install -D @powerboard/dev-router`](https://www.npmjs.com/package/@powerboard/dev-router) |
| **Operator** | This repository’s Cloudflare Worker | Clone the repo, `npx wrangler deploy` |

The published npm package is the **[client](https://www.npmjs.com/package/@powerboard/dev-router)**. Its only runtime dependency is `ws`. Build and test tooling (TypeScript, tsup, Wrangler, Vitest) stays in this repository’s `devDependencies` and is not installed with the client. The Worker source, Wrangler config, and Durable Objects live in this GitHub repository.

Management endpoints require `Authorization: Bearer <secret>`. Store the **operator** secret as the Worker secret `DEV_ROUTER_SECRET`.

## Use the client in a remote cloud environment

Amp orbs, Codespaces, Cursor, CI workers, containers, and private VMs use the same local URL interface. The sidecar runs **in** the environment and fetches `localUrl` itself. The Worker never needs that address.

### Reverse tunnel (recommended)

```bash
npm install -D @powerboard/dev-router

export DEV_ROUTER_URL=https://dev-webhooks.example.com
export DEV_ROUTER_SECRET=<minted credential; see table above>
# optional named prefix:
export DEV_ROUTER_ROUTE=nomads
export DEV_ROUTER_ENVIRONMENT_ID=$AMP_THREAD_ID

npx dev-router connect --local-url http://127.0.0.1:3000 --environment-id "$AMP_THREAD_ID"
```

Or from `package.json`:

```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:app\" \"dev-router connect --local-url http://127.0.0.1:3000\""
  }
}
```

The CLI prints `Public:` (give this URL to webhook/OAuth providers), `Forwarding to:` (the local origin the sidecar fetches), and `Control:` (`http://127.0.0.1:8790/ready`). It also reminds you that **replica mode** is not finished until this environment completes the app’s OAuth to the third-party provider.

The app process should **not** import `DevRouterClient`. Bind OAuth `state` through the sidecar control server:

```http
POST http://127.0.0.1:8790/oauth-states
Content-Type: application/json

{"state":"<app-generated-state>"}
```

`GET /ready` is the Amp / process-manager readiness probe. It returns **503 until the live WebSocket is connected**. A parked subscriber id from `--environment-id` is not enough; reconnection is not ready. `--control-socket` uses a Unix socket instead of TCP. `--no-control` disables the listener. The control server binds loopback only.

`--environment-id` / `DEV_ROUTER_ENVIRONMENT_ID` keeps the same logical subscriber (and pending OAuth bindings) across WebSocket reconnects. Use a per-orb value such as `AMP_THREAD_ID`. A new process that reuses the same id replaces the old socket.

Each new cloud environment is a full replica. After `connect`, the first operator action is: open the app **in this environment** and finish OAuth. Do that after the sidecar is up (otherwise the callback is `404`). Tokens stay in this environment; the next orb repeats OAuth. Webhook fan-out is only useful for replicas that already have those tokens.

One-shot without adding a dependency:

```bash
npx --yes @powerboard/dev-router connect --route nomads --local-url http://127.0.0.1:3000
```

Do not run `npx dev-router` in a project that has not installed this package. npm will look up an unrelated public package named `dev-router`. Prefer `npx --yes @powerboard/dev-router connect` or install first.

`--local-url` can be any origin the sidecar can fetch (`http://127.0.0.1:3000`, `http://app:3000`, `http://host.docker.internal:5173`). It does not need to be loopback, and it does not need to be reachable from Cloudflare.

The client heartbeats over the WebSocket, reconnects with backoff, and fails the socket if a pong is missing for 75 seconds. On SIGINT/SIGTERM it closes the socket **before** aborting other work. Anonymous tunnel subscribers are removed as soon as the socket closes. Environment-identified subscribers stay parked for five minutes so an in-flight OAuth callback can still be correlated after a reconnect. Stale tunnels with no ping are expired by the Worker.

### Amp orb example

Commit `.amp/services.yaml` in the **app** repository (not this Worker repo). Amp injects `PORT` and `AMP_THREAD_ID`; do not set those in `env`. Store `DEV_ROUTER_URL` and the minted credential as Amp project secrets named `DEV_ROUTER_URL` and `DEV_ROUTER_SECRET`.

This example uses **root routing** (no `--route`) and a **direct** readiness check: Amp GETs `/ready` on the sidecar control port, which is 503 until the WebSocket is live.

```yaml
services:
  app:
    command: npm run dev -- --host 0.0.0.0 --port "$PORT"
    port: 3000
    portal: true
  router:
    command: >-
      npx dev-router connect
      --local-url http://127.0.0.1:3000
      --environment-id "$AMP_THREAD_ID"
      --control-port "$PORT"
    port: 8790
    health: /ready
```

`amp orb services ensure` starts both processes. The app listens on 3000. The sidecar reverse-tunnels to that origin, binds the loopback control server on 8790 (`GET /ready`, `POST /oauth-states`), and keeps the same subscriber across reconnects via `AMP_THREAD_ID`.

Mint the matching **root-scoped** credential on a machine that has the operator secret:

```bash
npx dev-router token
```

If you instead pass `--route nomads` on connect, mint `npx dev-router token --route nomads` and add `--route nomads` to the router `command`. Do not mix a root credential with a named `--route`.

The app still binds OAuth `state` with `POST http://127.0.0.1:8790/oauth-states`. Amp’s `health: /ready` is a GET to the **router** service port (8790), not to the app.

### Optional public-target transport

If the environment already has a public `https://` origin, you can still register that URL instead of opening a tunnel:

```bash
export PUBLIC_DEV_URL=https://abc123.cloud-dev.example
npx dev-router connect --route my-web-app
```

That origin must be absolute `https://`, reachable from Cloudflare, and free of credentials or a fragment. `http://localhost` and IDE-only port-forwards are not valid public targets — use `--local-url` instead.

Detection order when `--local-url` and `--target` are omitted: `VSCODE_PROXY_URI`, GitHub Codespaces, Gitpod, Replit. Fallback is `https://dev-router-test.example`, which will not receive traffic.

`--local-url` and `--target` are mutually exclusive.

Programmatic equivalent:

```ts
import { DevRouterClient } from "@powerboard/dev-router";

const client = new DevRouterClient({
  routerUrl: process.env.DEV_ROUTER_URL!,
  secret: process.env.DEV_ROUTER_SECRET!
});

const connection = await client.connect({
  routeId: process.env.DEV_ROUTER_ROUTE, // omit or "" for router root
  localUrl: process.env.DEV_ROUTER_LOCAL_URL ?? "http://127.0.0.1:3000",
  environmentId: process.env.DEV_ROUTER_ENVIRONMENT_ID
});

const oauthState = await connection.wrapOAuthState();
await connection.bindOAuthState(appGeneratedState);

await connection.disconnect();
```

`routeId` must match `^[A-Za-z0-9._~-]+$` and must not be `_router` or `dashboard`.

Task documentation and Agent Skills:

- [Connect a cloud environment](skills/connect/connect.md)
- [Deploy the shared router](skills/deploy/deploy.md)
- [Request forwarding contract](skills/forwarding/forwarding.md)

## Request forwarding (subscriber apps)

**Webhooks** fan out to every subscriber. The public caller receives `202` `{ "accepted": true }` as soon as the Worker accepts fan-out. That is **not** delivery proof: subscriber status codes are not propagated, and a 202 can succeed while a replica never handled the request. Confirm the payload in **each** subscriber’s logs before treating a fan-out test as successful.

**OAuth** is single-target and returns the subscriber response (including redirects). Correlate with `wrapOAuthState()` / `bindOAuthState()` on the sidecar connection, or `POST http://127.0.0.1:8790/oauth-states` from the app process. If a route has exactly one subscriber, that subscriber is used. Multiple subscribers without a matching `state` return `409` `{ "error": "oauth_unroutable" }`.

No subscribers → `404` `{ "error": "route_not_found" }`.

Forwarded requests keep method, body, query string, and non-hop-by-hop headers, plus `X-Dev-Router-Route`, `X-Dev-Router-Subscriber`, `X-Dev-Router-Request-Id`, `X-Dev-Router-Token` (per-connection hop credential, not the management secret), and `X-Forwarded-*` when a client IP exists. Reverse-tunnel `Host` is taken from `localUrl`; `X-Forwarded-Host` keeps the public host. The Worker does not send `X-Dev-Router-Secret`. Each delivery has a 10s timeout and does not follow redirects.

## Deploy the shared Worker

Clone this repository (not only the npm client):

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler types
npx wrangler deploy
npx wrangler secret put DEV_ROUTER_SECRET
npx wrangler secret put DEV_ROUTER_DASHBOARD_PASSWORD
```

Bind a hostname such as `dev-webhooks.example.com` in the Cloudflare dashboard. Point every client at that origin with `DEV_ROUTER_URL`. Mint a root-scoped credential with `npx dev-router token`, or a named-route credential with `npx dev-router token --route <routeId>`, using the operator secret; give orbs only that token. Clients need outbound HTTPS and WSS to that host.

`GET /dashboard` and `GET /dashboard.json` are password-gated status surfaces (HTTP Basic, password `DEV_ROUTER_DASHBOARD_PASSWORD`; username can be blank). They list active routes, subscriber counts, transport, and environment id. They do not return `DEV_ROUTER_SECRET`, route credentials, connection tokens, or forward tokens. Management bearer auth applies only to `/_router/*`.

## Agent Skills (TanStack Intent)

This package ships versioned Agent Skills in `skills/` with the npm tarball. They match the installed `@powerboard/dev-router` version.

### Maintainers

Skill files stay beside their source docs (`skills/<task>/SKILL.md` next to `skills/<task>/<task>.md`). CI runs `intent validate` on PRs that touch skills. `intent stale` is conservative: it flags version drift and **new** `sources` entries that lack a recorded SHA in `skills/sync-state.json`. It does not prove remote documentation changed.

```bash
npx intent validate
npx intent stale
```

### Consumers

Intent scans installed dependencies as files. It does not import, require, or execute package code to discover or load skills.

Permit this package explicitly. Discovery is not trust:

```json
{
  "intent": {
    "skills": ["@powerboard/dev-router"],
    "exclude": []
  }
}
```

Use `intent.exclude` to drop a package or named skill after the allowlist (for example `"@powerboard/dev-router#deploy"` if this app only consumes the client).

Load only the skill for the current task:

```bash
npx @tanstack/intent@latest install
npx @tanstack/intent@latest list
npx @tanstack/intent@latest load @powerboard/dev-router#connect
```

| Task | Skill |
| --- | --- |
| Sidecar CLI or `DevRouterClient` in a cloud environment | `@powerboard/dev-router#connect` |
| Deploy the shared Worker | `@powerboard/dev-router#deploy` |
| Implement the app that receives traffic | `@powerboard/dev-router#forwarding` |

`intent hooks install` can add session catalogs and edit gates for some agents. Those hooks are a convenience. They can observe a list/load command; they do not verify that the command succeeded, that the skill matched the task, or that the model applied it. They are not a security boundary.

## Local development of this repository

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler types
npm test
npx wrangler dev
```

Requires Node.js 20+.

## License

[MIT](LICENSE)
