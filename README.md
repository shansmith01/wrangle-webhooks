# [@powerboard/dev-router](https://www.npmjs.com/package/@powerboard/dev-router)

[npm](https://www.npmjs.com/package/@powerboard/dev-router)

Shared Cloudflare ingress for ephemeral cloud development environments. Deploy the Worker once, then install the npm client in any project that needs a **stable public URL**.

Webhook providers, OAuth apps, and other external services call the Worker. The Worker fans the request out to whichever cloud environments are currently registered. The npm client is a sidecar: it only registers, heartbeats, and deregisters. It does not proxy HTTP.

```text
External service
      |
      v
https://dev-webhooks.example.com[/<routeId>]/<any-path>
      |
      v
Shared Cloudflare Worker + Durable Object
      |
      +--> Dev Environment A  (public https:// origin)
      +--> Dev Environment B
```

The router is generic. It does not distinguish webhooks, OAuth callbacks, or any other HTTP request.

`routeId` is an optional public path prefix, not a private identifier:

- omitted / empty → `https://dev-webhooks.example.com/oauth/callback`
- `my-web-app` → `https://dev-webhooks.example.com/my-web-app/oauth/callback`

If a named route has active subscribers, it wins for that prefix. Otherwise an empty-route subscriber receives the full path.

## Two packages of work

| Role | What you use | Install |
| --- | --- | --- |
| **App / cloud environment** | Sidecar CLI and `DevRouterClient` | [`npm install -D @powerboard/dev-router`](https://www.npmjs.com/package/@powerboard/dev-router) |
| **Operator** | This repository’s Cloudflare Worker | Clone the repo, `npx wrangler deploy` |

The published npm package is the **[client](https://www.npmjs.com/package/@powerboard/dev-router)**. The Worker source, Wrangler config, and Durable Objects live in this GitHub repository.

Management endpoints require `Authorization: Bearer <secret>`. Store that value as the Worker secret `DEV_ROUTER_SECRET`. Give the same secret to clients as `DEV_ROUTER_SECRET`.

## Use the client in a remote cloud environment

The Worker delivers traffic with `fetch()` from Cloudflare to `targetBaseUrl`. That URL must be:

- absolute `https://` (not `http://`, not `localhost`)
- reachable **from the public internet** (Cloudflare’s network), not only from your laptop or an IDE preview
- free of username/password and fragments
- a base origin or origin plus path (`https://host` or `https://host/dev-ingress`)

Desktop and many “cloud agent” previews only **port-forward to localhost on your machine**. That is useful for you in a browser. It is **not** a target the Worker can call.

### 1. Configure the sidecar

```bash
npm install -D @powerboard/dev-router

export DEV_ROUTER_URL=https://dev-webhooks.example.com
export DEV_ROUTER_SECRET=<same secret as the Worker>
# optional:
export DEV_ROUTER_ROUTE=my-web-app
export DEV_ROUTER_PORT=3000
```

Run the sidecar next to the app (same machine / same VM):

```bash
npx dev-router connect
```

Or from `package.json`:

```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:app\" \"dev-router connect\""
  }
}
```

The CLI prints `Public:` (give this URL to webhook/OAuth providers) and `Forwarding to:` (must be the environment’s public HTTPS origin).

One-shot without adding a dependency:

```bash
npx --yes @powerboard/dev-router connect
```

Do not run `npx dev-router` in a project that has not installed this package. npm will look up an unrelated public package named `dev-router`. Prefer `npx --yes @powerboard/dev-router connect` or install first.

### 2. Give the Worker a reachable HTTPS origin

Bind the app to `0.0.0.0` and the port you register (`PORT` / `DEV_ROUTER_PORT` / `--port`, default `3000`). Then expose that port on a public HTTPS hostname.

| Environment | Auto-detect? | What to do |
| --- | --- | --- |
| **GitHub Codespaces** | Yes (`CODESPACE_NAME` + port-forwarding domain) | Forward the app port and set visibility to **public**. Private ports are not reachable from Cloudflare. |
| **Gitpod** | Yes (`GITPOD_WORKSPACE_URL`) | Use the generated `https://<port>-<workspace-host>` URL; keep the port open. |
| **Replit** | Yes (`REPLIT_DEV_DOMAIN`) | Use the Replit dev domain as-is. |
| **VS Code / Cursor tunnels** | Yes when `VSCODE_PROXY_URI` is set | Use the tunnel URL for that port. Confirm it loads from a phone or `curl` off your LAN, not only the IDE preview. |
| **Cursor Cloud Agents** | No | Port-forward to your laptop is not enough. Publish an ingress-reachable HTTPS URL (Codespaces-style public port, named Cloudflare Tunnel, or `cloudflared tunnel --url http://127.0.0.1:<port>`), then set `PUBLIC_DEV_URL` / `--target` to that `https://` origin. Store `DEV_ROUTER_URL` and `DEV_ROUTER_SECRET` as Cloud Agent secrets. If the agent uses an egress allowlist, allow the Worker hostname so register/heartbeat can reach it. |
| **Render, Fly, Railway, generic VM** | No | Set `PUBLIC_DEV_URL` to the service’s existing public `https://` origin (the router still gives you a **stable** hostname while that origin may change). Bind HTTP to `0.0.0.0:$PORT`. |
| **Laptop / no detector** | Fallback only | Detection falls back to `https://dev-router-test.example`, which **will not receive traffic**. Run a tunnel (for example Cloudflare Quick Tunnels) and pass `--target`. |

Detection order: `VSCODE_PROXY_URI`, then GitHub Codespaces, then Gitpod, then Replit. Port comes from `--port`, `DEV_ROUTER_PORT`, `PORT`, then `3000`.

Override whenever detection is wrong or missing:

```bash
npx dev-router connect --port 5173 --target https://abc123.cloud-dev.example
```

Quick Tunnel pattern (Cursor Cloud Agents, local laptops, locked-down VMs):

```bash
# App on 0.0.0.0:3000, then:
npx --yes cloudflared tunnel --url http://127.0.0.1:3000
# copy the https://*.trycloudflare.com URL
export PUBLIC_DEV_URL=https://<random>.trycloudflare.com
npx dev-router connect --route my-web-app
```

Heartbeats every 60 seconds keep the subscriber alive. Expiry is 5 minutes of silence. SIGINT/SIGTERM deregisters; TTL covers a failed DELETE.

Programmatic equivalent:

```ts
import { DevRouterClient } from "@powerboard/dev-router";

const client = new DevRouterClient({
  routerUrl: process.env.DEV_ROUTER_URL!,
  secret: process.env.DEV_ROUTER_SECRET!
});

const connection = await client.connect({
  routeId: process.env.DEV_ROUTER_ROUTE, // omit or "" for router root
  targetBaseUrl: process.env.PUBLIC_DEV_URL, // omit to auto-detect
  port: 3000
});

await connection.disconnect();
```

`routeId` must match `^[A-Za-z0-9._~-]+$` and must not be `_router` or `dashboard`.

Task documentation and Agent Skills:

- [Connect a cloud environment](skills/connect/connect.md)
- [Deploy the shared router](skills/deploy/deploy.md)
- [Request forwarding contract](skills/forwarding/forwarding.md)

## Request forwarding (subscriber apps)

The public caller always receives `202` `{ "accepted": true }` once subscribers exist. Subscriber status codes are not propagated. No subscribers → `404` `{ "error": "route_not_found" }`.

Forwarded requests keep method, body, query string, and non-hop-by-hop headers, plus `X-Dev-Router-Route`, `X-Dev-Router-Subscriber`, `X-Dev-Router-Request-Id`, `X-Dev-Router-Secret` (treat as an internal hop credential), and `X-Forwarded-*` when a client IP exists. Each delivery has a 10s timeout and does not follow redirects.

## Deploy the shared Worker

Clone this repository (not only the npm client):

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler types
npx wrangler deploy
npx wrangler secret put DEV_ROUTER_SECRET
```

Bind a hostname such as `dev-webhooks.example.com` in the Cloudflare dashboard. Point every client at that origin with `DEV_ROUTER_URL`.

`GET /dashboard` and `GET /dashboard.json` are **public** status surfaces. They list active routes and subscriber counts. They do not return `DEV_ROUTER_SECRET`. Bearer auth applies only to `/_router/*`.

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
