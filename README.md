# Cloud Dev Ingress Router

Shared Cloudflare ingress for ephemeral cloud development environments. Deploy the Worker once, then install the npm client in any project that needs a stable public URL.

```text
External service
      |
      v
https://dev-webhooks.example.com[/<routeId>]/<any-path>
      |
      v
Shared Cloudflare Worker + Durable Object
      |
      +--> Dev Environment A
      +--> Dev Environment B
```

The router is generic. It does not distinguish webhooks, OAuth callbacks, or any other HTTP request.

`routeId` is an optional public path prefix, not a private identifier:

- omitted / empty → `https://dev-webhooks.example.com/oauth/callback`
- `my-web-app` → `https://dev-webhooks.example.com/my-web-app/oauth/callback`

If a named route has active subscribers, it wins for that prefix. Otherwise an empty-route subscriber receives the full path.

## Architecture

- **Worker** — public HTTP API and management API under `/_router/*`
- **Durable Object per `routeId`** — subscriber registration, heartbeats, expiry, fan-out coordination
- **npm client** — development sidecar that only registers, heartbeats, and deregisters

Management endpoints require `Authorization: Bearer <secret>`. Store that value as the Worker secret `DEV_ROUTER_SECRET`.

Task documentation lives next to the Agent Skills that distill it:

- [Connect a cloud environment](skills/connect/connect.md)
- [Deploy the shared router](skills/deploy/deploy.md)
- [Request forwarding contract](skills/forwarding/forwarding.md)

## Agent Skills (TanStack Intent)

This package ships versioned Agent Skills in `skills/` with the npm tarball. They match the installed `@wrangle/dev-router` version.

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
    "skills": ["@wrangle/dev-router"],
    "exclude": []
  }
}
```

Use `intent.exclude` to drop a package or named skill after the allowlist (for example `"@wrangle/dev-router#deploy"` if this app only consumes the client).

Load only the skill for the current task:

```bash
npx @tanstack/intent@latest install
npx @tanstack/intent@latest list
npx @tanstack/intent@latest load @wrangle/dev-router#connect
```

| Task | Skill |
| --- | --- |
| Sidecar CLI or `DevRouterClient` | `@wrangle/dev-router#connect` |
| Deploy the shared Worker | `@wrangle/dev-router#deploy` |
| Implement the app that receives traffic | `@wrangle/dev-router#forwarding` |

`intent hooks install` can add session catalogs and edit gates for some agents. Those hooks are a convenience. They can observe a list/load command; they do not verify that the command succeeded, that the skill matched the task, or that the model applied it. They are not a security boundary.

## Local development of this repository

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler types
npm test
npx wrangler dev
```

## License

[MIT](LICENSE)
