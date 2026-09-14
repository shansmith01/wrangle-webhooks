# Connect a cloud environment

Install `@powerboard/dev-router` in a project that needs a stable public URL, then run the sidecar **on the same machine as the app**.

Two transports share that sidecar:

- **Reverse tunnel** (`--local-url` / `DEV_ROUTER_LOCAL_URL`) — the client opens an outbound WebSocket to the Worker and forwards each request to a local HTTP origin. Use this for Amp orbs, Codespaces, Cursor, CI workers, containers, and private VMs. The Worker never fetches the local URL.
- **Public target** (`--target` / `PUBLIC_DEV_URL`) — optional, for environments that already have a public `https://` origin Cloudflare can `fetch()`.

```bash
npm install -D @powerboard/dev-router
```

```bash
export DEV_ROUTER_URL=https://dev-webhooks.example.com
export DEV_ROUTER_SECRET=<route credential>

npx dev-router connect --route nomads --local-url http://127.0.0.1:3000 --environment-id "$AMP_THREAD_ID"
```

After install, `npx dev-router` uses `node_modules/.bin/dev-router`. Do not run `npx dev-router` in a project that has not installed `@powerboard/dev-router` — npm will look up a different public package named `dev-router`.

One-shot without adding a dependency:

```bash
npx --yes @powerboard/dev-router connect --route nomads --local-url http://127.0.0.1:3000
```

If `DEV_ROUTER_URL` or `DEV_ROUTER_SECRET` is missing, the CLI prints an error and exits.

Mint a join credential from the operator secret so each project cannot join other routes. Match the connect command:

```bash
npx dev-router token                 # root-scoped; omit --route on connect
npx dev-router token --route nomads  # named route only
```

Give that value to orbs as `DEV_ROUTER_SECRET`. Keep the Worker operator secret off replica environments. A root-scoped credential cannot join `nomads`; a nomads credential cannot join root.

`--route` / `DEV_ROUTER_ROUTE` is optional. Omitting it publishes at the router root with **no project prefix**: providers call `https://dev-webhooks.example.com/oauth/callback`, not `https://dev-webhooks.example.com/nomads/oauth/callback`.

Treat the client as a sidecar, not in-process middleware:

```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:app\" \"dev-router connect --local-url http://127.0.0.1:3000\""
  }
}
```

## Reverse tunnel (private environments)

Run the sidecar **inside** the environment that serves the app. Bind the app to `0.0.0.0` (or loopback) and pass the URL the sidecar can fetch:

```bash
npx dev-router connect --route nomads --local-url http://127.0.0.1:3000
```

The same `--local-url` interface is used on Amp, Codespaces, Cursor, CI, containers, and private VMs. The Worker multiplexes public HTTP over the WebSocket. The client heartbeats with WebSocket `ping`/`pong`, reconnects with backoff, and closes the socket if a pong is missing for 75 seconds. SIGINT/SIGTERM closes the socket so anonymous subscribers are removed immediately. Pass `--environment-id` so reconnects reuse the same subscriber and keep pending OAuth bindings for five minutes.

The sidecar also listens on loopback (`http://127.0.0.1:8790` by default):

- `GET /ready` — Amp / process-manager readiness. Returns **503 until the live WebSocket is connected**. A parked `--environment-id` subscriber is not ready during reconnect.
- `POST /oauth-states` `{ "state": "..." }` — bind this replica’s OAuth `state`
- `POST /oauth-wrap` `{ "inner": "..." }` — wrap a nonce without importing router crypto

The app process should call that control server. Do not run `DevRouterClient` inside the API. `--control-socket` uses a Unix socket. `--no-control` disables it.

`--local-url` and `--target` are mutually exclusive.

## Amp orb example

In the **app** repository, commit `.amp/services.yaml`. Amp injects `PORT` and `AMP_THREAD_ID`; do not set them in `env`. Put `DEV_ROUTER_URL` and the minted credential in Amp project secrets.

Root routing (no `--route`) plus a **direct** `/ready` check on the sidecar control port:

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

`health: /ready` is a GET to the **router** service (`127.0.0.1:8790/ready`), not the app. It stays 503 until the tunnel WebSocket is up. The app binds OAuth state with `POST http://127.0.0.1:8790/oauth-states`. Mint the matching root credential with `npx dev-router token`. For a named prefix, add `--route <id>` to `command` and mint `npx dev-router token --route <id>`.

## Replica mode: OAuth this environment before webhooks matter

The router fans webhooks out to every connected replica. Authenticated follow-up (the app calling the provider right after a webhook) only works on replicas that already have **this environment’s** OAuth tokens.

Treat every new cloud environment as unsorted until the operator finishes the app’s OAuth flow to the third-party provider **in that environment**:

1. Start the app and `dev-router connect` (sidecar first, or the callback is `404`).
2. Prompt the operator: the environment is subscribed; they still need to OAuth-register with the provider here.
3. Use the printed `Public:` URL as the OAuth redirect URI, not `localhost`.
4. If other replicas are already on the same route, the app must bind `state` so this orb owns the authorization code: `POST http://127.0.0.1:8790/oauth-states` or `connection.bindOAuthState()` / `wrapOAuthState()` from the sidecar process.
5. Store tokens in this environment. The next orb does not inherit them.

Until step 4–5 succeed, do not tell the operator that webhooks are ready. Fan-out to an unauthenticated replica is failed follow-up calls.

## Public target (optional)

Use this only when the environment already has a Cloudflare-reachable `https://` origin.

`connect` can still detect a public URL in this order when `--local-url` is omitted:

1. **VS Code / Cursor port forwarding** — `VSCODE_PROXY_URI`
2. **GitHub Codespaces** — `CODESPACE_NAME` + `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN`
3. **Gitpod** — `GITPOD_WORKSPACE_URL`
4. **Replit** — `REPLIT_DEV_DOMAIN`

On Codespaces, a detected port must be **public**. IDE port-forward to `localhost` on a laptop is not a Worker target.

```bash
export PUBLIC_DEV_URL=https://<ingress-host>
npx dev-router connect --port 3000 --route my-web-app
```

If nothing is detected, the CLI uses `https://dev-router-test.example` so registration can be exercised. That host **does not receive real traffic**. Prefer `--local-url` instead of a dummy public target.

## Programmatic API

```ts
import { DevRouterClient } from "@powerboard/dev-router";

const client = new DevRouterClient({
  routerUrl: process.env.DEV_ROUTER_URL!,
  secret: process.env.DEV_ROUTER_SECRET!
});

const connection = await client.connect({
  routeId: "nomads",
  localUrl: "http://127.0.0.1:3000",
  environmentId: process.env.DEV_ROUTER_ENVIRONMENT_ID
});

const state = await connection.wrapOAuthState();
await connection.bindOAuthState(appGeneratedState);

await connection.disconnect();
```

`targetBaseUrl` selects public-target transport. Explicit values must be absolute HTTPS URLs without credentials. `http://localhost` is rejected as a public target.

`localUrl` must be an absolute `http://` or `https://` URL without credentials. It is fetched only by the sidecar.

## Environment and flags

| Name | Role |
| --- | --- |
| `DEV_ROUTER_URL` / `--url` | Shared router base URL |
| `DEV_ROUTER_SECRET` / `--secret` | Operator secret or minted route credential |
| `DEV_ROUTER_ROUTE` / `--route` | Optional public path prefix (`A-Za-z0-9._~-`, not `_router` or `dashboard`) |
| `DEV_ROUTER_PORT` / `PORT` / `--port` | Local app port used when constructing a detected public URL (default `3000`) |
| `DEV_ROUTER_LOCAL_URL` / `--local-url` | Local HTTP origin for reverse-tunnel mode |
| `DEV_ROUTER_ENVIRONMENT_ID` / `--environment-id` | Stable subscriber identity across reconnects |
| `DEV_ROUTER_CONTROL_PORT` / `--control-port` | Loopback control port (default `8790`) |
| `DEV_ROUTER_CONTROL_SOCKET` / `--control-socket` | Unix socket instead of TCP |
| `DEV_ROUTER_CONTROL_TOKEN` / `--control-token` | Optional bearer token for the control server |
| `PUBLIC_DEV_URL` / `--target` | Optional public HTTPS origin (public-target transport) |

Tunnel connections stay alive while the WebSocket is open. Anonymous tunnels are removed as soon as the socket closes. Environment-identified tunnels park for 5 minutes so OAuth bindings survive a reconnect. Public-target subscribers heartbeat every 60 seconds and expire after 5 minutes of silence. The Worker also expires stale tunnels that miss pings.
