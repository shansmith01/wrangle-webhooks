# Connect a cloud environment

Install `@wrangle/dev-router` in a project that needs a stable public URL, then run the sidecar. The client only registers, heartbeats, and deregisters. It is not application runtime.

This package is not on the npm registry yet (`npx dev-router` will 404 until then). Install from GitHub:

```bash
npm install -D github:shansmith01/wrangle-webhooks
```

```bash
export DEV_ROUTER_URL=https://dev-router.websupport-4ba.workers.dev
export DEV_ROUTER_SECRET=<secret>

npx dev-router connect
```

After the GitHub install, `npx dev-router` uses `node_modules/.bin/dev-router` from this package (`@wrangle/dev-router`). Do not run `npx dev-router` in a project that has not installed it first — npm will look up a public package named `dev-router`.

One-shot without adding a dependency:

```bash
npx --yes github:shansmith01/wrangle-webhooks connect
```

Do not put `dev-router` after the GitHub URL. npm already runs that binary; extra `dev-router` is an argument, not the package name.

If `DEV_ROUTER_URL` or `DEV_ROUTER_SECRET` is missing, the CLI prints an error and exits.

That publishes the environment at the router root (`https://dev-webhooks.example.com/*`). Pass `--route my-web-app` or `DEV_ROUTER_ROUTE` only when you want a project prefix.

`connect` detects the current cloud environment's public URL (GitHub Codespaces, VS Code tunnels, Gitpod, and similar). It uses `DEV_ROUTER_PORT` or `PORT` when the platform URL includes a port, and defaults to `3000`.

Override only when detection is wrong:

```bash
npx dev-router connect --port 5173
npx dev-router connect --target https://abc123.cloud-dev.example
```

Treat the client as a sidecar, not application runtime:

```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:app\" \"dev-router connect\""
  }
}
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

`targetBaseUrl` is optional. When omitted, the client detects the environment's public `https://` origin. Explicit values must be absolute HTTPS URLs without credentials. A base path is allowed (`https://host/dev-ingress`).

## Environment and flags

| Name | Role |
| --- | --- |
| `DEV_ROUTER_URL` / `--url` | Shared router base URL |
| `DEV_ROUTER_SECRET` / `--secret` | Management bearer secret |
| `DEV_ROUTER_ROUTE` / `--route` | Optional public path prefix (`A-Za-z0-9._~-`, not `_router` or `dashboard`) |
| `DEV_ROUTER_PORT` / `PORT` / `--port` | Local app port used when constructing the detected URL (default `3000`) |
| `PUBLIC_DEV_URL` / `--target` | Optional override for the environment's public HTTPS URL |

Heartbeat interval is 60 seconds. Subscriber expiry is 5 minutes. Failed deregister is cleaned up by TTL.
