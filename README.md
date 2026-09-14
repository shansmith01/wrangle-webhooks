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

`routeId` is an optional public path prefix, not a private identifier:

- omitted / empty → `https://dev-webhooks.example.com/oauth/callback`
- `my-web-app` → `https://dev-webhooks.example.com/my-web-app/oauth/callback`

If a named route has active subscribers, it wins for that prefix. Otherwise an empty-route subscriber receives the full path.

Webhooks fan out to every subscriber. OAuth callbacks are routed to **one** subscriber and that subscriber’s response is returned to the public caller.

## Two packages of work

| Role | What you use | Install |
| --- | --- | --- |
| **App / cloud environment** | Sidecar CLI and `DevRouterClient` | [`npm install -D @powerboard/dev-router`](https://www.npmjs.com/package/@powerboard/dev-router) |
| **Operator** | This repository’s Cloudflare Worker | Clone the repo, `npx wrangler deploy` |

The published npm package is the **[client](https://www.npmjs.com/package/@powerboard/dev-router)**. The Worker source, Wrangler config, and Durable Objects live in this GitHub repository.

Management endpoints require `Authorization: Bearer <secret>`. Store the **operator** secret as the Worker secret `DEV_ROUTER_SECRET`. Mint a **route** credential for each project (`npx dev-router token --route nomads`) and give that value to orbs as `DEV_ROUTER_SECRET`. Do not hand every environment the operator secret.

## Use the client in a remote cloud environment

## Use the client in a remote cloud environment

Amp orbs, Codespaces, Cursor, CI workers, containers, and private VMs use the same local URL interface. The sidecar runs **in** the environment and fetches `localUrl` itself. The Worker never needs that address.

### Reverse tunnel (recommended)

```bash
npm install -D @powerboard/dev-router

export DEV_ROUTER_URL=https://dev-webhooks.example.com
export DEV_ROUTER_SECRET=<route credential from `dev-router token --route nomads`>
# optional:
export DEV_ROUTER_ROUTE=nomads
export DEV_ROUTER_ENVIRONMENT_ID=$AMP_THREAD_ID

npx dev-router connect --route nomads --local-url http://127.0.0.1:3000 --environment-id "$AMP_THREAD_ID"
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

`GET /ready` is the Amp / process-manager readiness probe. `--control-socket` uses a Unix socket instead of TCP. `--no-control` disables the listener. The control server binds loopback only.

`--environment-id` / `DEV_ROUTER_ENVIRONMENT_ID` keeps the same logical subscriber (and pending OAuth bindings) across WebSocket reconnects. Use a per-orb value such as `AMP_THREAD_ID`. A new process that reuses the same id replaces the old socket.

Each new cloud environment is a full replica. After `connect`, the first operator action is: open the app **in this environment** and finish OAuth. Do that after the sidecar is up (otherwise the callback is `404`). Tokens stay in this environment; the next orb repeats OAuth. Webhook fan-out is only useful for replicas that already have those tokens.

One-shot without adding a dependency:

```bash
npx --yes @powerboard/dev-router connect --route nomads --local-url http://127.0.0.1:3000
```

Do not run `npx dev-router` in a project that has not installed this package. npm will look up an unrelated public package named `dev-router`. Prefer `npx --yes @powerboard/dev-router connect` or install first.

`--local-url` can be any origin the sidecar can fetch (`http://127.0.0.1:3000`, `http://app:3000`, `http://host.docker.internal:5173`). It does not need to be loopback, and it does not need to be reachable from Cloudflare.

The client heartbeats over the WebSocket, reconnects with backoff, and fails the socket if a pong is missing for 75 seconds. On SIGINT/SIGTERM it closes the socket **before** aborting other work. Anonymous tunnel subscribers are removed as soon as the socket closes. Environment-identified subscribers stay parked for five minutes so an in-flight OAuth callback can still be correlated after a reconnect. Stale tunnels with no ping are expired by the Worker.

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

**Webhooks** fan out to every subscriber. The public caller receives `202` `{ "accepted": true }`. Subscriber status codes are not propagated.

**OAuth** is single-target and returns the subscriber response (including redirects). Correlate with `wrapOAuthState()` / `bindOAuthState()` on the sidecar connection, or `POST http://127.0.0.1:8790/oauth-states` from the app process. If a route has exactly one subscriber, that subscriber is used. Multiple subscribers without a matching `state` return `409` `{ "error": "oauth_unroutable" }`.

No subscribers → `404` `{ "error": "route_not_found" }`.

Forwarded requests keep method, body, query string, and non-hop-by-hop headers, plus `X-Dev-Router-Route`, `X-Dev-Router-Subscriber`, `X-Dev-Router-Request-Id`, `X-Dev-Router-Token` (per-connection hop credential, not the management secret), and `X-Forwarded-*` when a client IP exists. The Worker does not send `X-Dev-Router-Secret`. Each delivery has a 10s timeout and does not follow redirects.

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

Bind a hostname such as `dev-webhooks.example.com` in the Cloudflare dashboard. Point every client at that origin with `DEV_ROUTER_URL`. Mint route credentials with `npx dev-router token --route <routeId>` using the operator secret; give orbs only that route token. Clients need outbound HTTPS and WSS to that host.

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
