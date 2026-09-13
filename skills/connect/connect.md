# Connect a cloud environment

Install `@wrangle/dev-router` in a project that needs a stable public URL, then run the sidecar **on the same machine as the app**. The client only registers, heartbeats, and deregisters. It is not application runtime and it does not receive HTTP.

The Worker fans traffic from Cloudflare to `targetBaseUrl`. That value must be an absolute public `https://` origin (or origin plus base path) that Cloudflare can fetch. IDE port-forward to `localhost` on your laptop is not sufficient.

```bash
npm install -D @wrangle/dev-router
```

```bash
export DEV_ROUTER_URL=https://dev-webhooks.example.com
export DEV_ROUTER_SECRET=<secret>

npx dev-router connect
```

After install, `npx dev-router` uses `node_modules/.bin/dev-router`. Do not run `npx dev-router` in a project that has not installed `@wrangle/dev-router` — npm will look up a different public package named `dev-router`.

One-shot without adding a dependency:

```bash
npx --yes @wrangle/dev-router connect
```

If `DEV_ROUTER_URL` or `DEV_ROUTER_SECRET` is missing, the CLI prints an error and exits.

That publishes the environment at the router root (`https://dev-webhooks.example.com/*`). Pass `--route my-web-app` or `DEV_ROUTER_ROUTE` only when you want a project prefix.

Treat the client as a sidecar, not application runtime:

```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:app\" \"dev-router connect\""
  }
}
```

## Remote cloud environments

Register from **inside** the environment that runs the app. The sidecar needs outbound HTTPS to `DEV_ROUTER_URL` (register + heartbeat). The app needs inbound HTTPS from Cloudflare at `targetBaseUrl`.

Bind the HTTP server to `0.0.0.0` and the port you advertise (`--port`, `DEV_ROUTER_PORT`, or `PORT`; default `3000`).

### Auto-detected platforms

`connect` detects a public URL in this order:

1. **VS Code / Cursor port forwarding** — `VSCODE_PROXY_URI` (substitutes `{{port}}` / `{port}`)
2. **GitHub Codespaces** — `CODESPACE_NAME` + `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN` → `https://<name>-<port>.<domain>`
3. **Gitpod** — `GITPOD_WORKSPACE_URL` → `https://<port>-<workspace-host>`
4. **Replit** — `REPLIT_DEV_DOMAIN`

On Codespaces, the forwarded port must be **public**. Private ports are not reachable from the Worker.

Confirm the printed `Forwarding to:` URL with `curl` from a network that is not the IDE (a phone hotspot is enough). If only the IDE preview works, the Worker will time out.

### Cursor Cloud Agents and other non-detected hosts

Cursor Cloud Agents (and similar remote VMs) typically **forward ports to your local machine** for preview. Cloudflare cannot call `localhost` on your laptop or an unpublished agent port.

Do this instead:

1. Store `DEV_ROUTER_URL` and `DEV_ROUTER_SECRET` as environment secrets for the agent (runtime secret for the bearer token). Optionally set `DEV_ROUTER_ROUTE`.
2. Start the app on `0.0.0.0:<port>`.
3. Publish a Cloudflare-reachable HTTPS URL for that port: a platform public port, a named Cloudflare Tunnel, or a Quick Tunnel (`cloudflared tunnel --url http://127.0.0.1:<port>`).
4. Point the sidecar at that URL:

```bash
export PUBLIC_DEV_URL=https://<ingress-host>
npx dev-router connect --port 3000 --route my-web-app
```

5. If the agent egress allowlist is on, allow the Worker hostname so POST `/_router/...` register and heartbeat succeed.
6. Give providers the printed `Public:` URL (`https://<router>/<routeId>/*`), not the tunnel hostname, when you want a stable callback.

Render, Fly, Railway, and other already-public hosts: set `PUBLIC_DEV_URL` to that service’s `https://` origin. Detection will not invent it.

### Local laptop and the test fallback

If nothing is detected, the CLI uses `https://dev-router-test.example` so registration can be exercised. That host **does not receive real traffic**. For local apps, run a tunnel and pass `--target` / `PUBLIC_DEV_URL`.

Override whenever detection is wrong:

```bash
npx dev-router connect --port 5173
npx dev-router connect --target https://abc123.cloud-dev.example
```

## Programmatic API

```ts
import { DevRouterClient } from "@wrangle/dev-router";

const client = new DevRouterClient({
  routerUrl: process.env.DEV_ROUTER_URL!,
  secret: process.env.DEV_ROUTER_SECRET!
});

const connection = await client.connect();

await connection.disconnect();
```

`routeId` is optional. Omit it (or pass `""`) for root ingress with no project prefix.

`targetBaseUrl` is optional. When omitted, the client detects the environment’s public `https://` origin. Explicit values must be absolute HTTPS URLs without credentials. A base path is allowed (`https://host/dev-ingress`). `http://localhost` is rejected.

## Environment and flags

| Name | Role |
| --- | --- |
| `DEV_ROUTER_URL` / `--url` | Shared router base URL |
| `DEV_ROUTER_SECRET` / `--secret` | Management bearer secret |
| `DEV_ROUTER_ROUTE` / `--route` | Optional public path prefix (`A-Za-z0-9._~-`, not `_router` or `dashboard`) |
| `DEV_ROUTER_PORT` / `PORT` / `--port` | Local app port used when constructing the detected URL (default `3000`) |
| `PUBLIC_DEV_URL` / `--target` | Override for the environment’s public HTTPS URL (required when detection cannot see a Cloudflare-reachable origin) |

Heartbeat interval is 60 seconds. Subscriber expiry is 5 minutes. Failed deregister is cleaned up by TTL.
