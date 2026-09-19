# Request forwarding contract

Give external providers the **router** URL (`Public:` from `dev-router connect`). The Worker then delivers to each subscriber over reverse tunnel or by `fetch()`ing a public `https://` target.

`routeId` is an optional public path prefix, not a private identifier. Omitting `--route` produces URLs **without** a project prefix:

- omitted / empty → `https://dev-webhooks.example.com/oauth/callback`
- `my-web-app` → `https://dev-webhooks.example.com/my-web-app/oauth/callback`

Mint `npx dev-router token` for root connect, or `npx dev-router token --route my-web-app` for a named prefix. Do not mix them.

If a named route has active subscribers, it wins for that prefix. Otherwise an empty-route subscriber receives the full path.

Incoming with a route prefix:

```text
POST https://dev-webhooks.example.com/project-a/api/hooks/payment?id=123
```

Forwarded to the subscriber (tunnel or public target):

```text
POST <subscriber>/api/hooks/payment?id=123
```

The original method, raw body, query string, and relevant headers are preserved.

## Webhooks vs OAuth

Webhooks use **fan-out**. By default every active subscriber receives a copy. The public caller gets `202 Accepted` `{ "accepted": true }` as soon as fan-out is accepted. That is **not** delivery proof: subscriber status codes are not propagated, and path filters or `--no-webhooks` can skip a replica. Confirm the request in **each** subscriber’s logs before treating a fan-out test as successful.

Webhook remaining-path filters are operator-owned. Empty settings mean accept everything. The dashboard **Deny all webhook fan-out** checkbox (or `PUT /_router/webhook-fanout` `{ "denyAllWebhooks": true }`) skips every subscriber on that route. Path rules (`PUT /_router/webhook-fanout-rules`) skip or only-send a remaining-path prefix, optionally scoped to one `--environment-id`. `--no-webhooks` / `DEV_ROUTER_NO_WEBHOOKS=1` mutes this subscriber only. Either mute skips delivery; the public caller still gets `202` while any subscriber is connected. OAuth reverse-proxy is unchanged. Minted route join tokens cannot mutate route filters.

OAuth callbacks use **correlated single-target routing** and **return the subscriber response** (status, `Location`, body). `Set-Cookie` is not copied onto the Worker host. That is required so authorization-code exchanges and redirects work. One `code` must go only to the subscriber that created its `state`.

A request is treated as OAuth when the remaining path is on the **admin allowlist** for that route **and** the query or form body has `code` or `error`. Register exact remaining paths (for example `/oauth/callback` or `/api/auth/callback/google`) in the dashboard or with `PUT /_router/oauth-callback-paths` / `PUT /_router/routes/<routeId>/oauth-callback-paths` using the operator secret. Minted route join tokens cannot expand the allowlist. Empty allowlist means no OAuth reverse proxy.

Paths that look like `/oauth/callback` or `/auth/callback` (including nested forms such as `/api/auth/callback/google`) but are **not** registered return `404` `{ "error": "oauth_callback_not_registered" }` with no proxy and no fan-out. The same reject applies when a signed `wrapOAuthState()` value (`dr1.` prefix) appears on a non-allowlisted path. Register product-specific callbacks such as `/api/integrations/oolio/callback` explicitly; they are not special-cased.

An allowlisted callback path with neither `code` nor `error` is `404` `{ "error": "oauth_callback_incomplete" }`: not a reverse proxy and not webhook fan-out. OAuth proxy is GET or POST only (`405` `{ "error": "oauth_method_not_allowed" }` otherwise). Arbitrary paths that merely include `state` and `code` (without a signed `dr1.` state) are webhook fan-out, not a reverse proxy. Bound app-generated `state` still works on complete allowlisted callback paths. Remaining paths with a `..` path-traversal segment after decode are `404` `{ "error": "route_not_found" }` with no forwarding, Durable Object delivery, or inbound-log row.

Routing order:

1. Signed `state` from `connection.wrapOAuthState()` (`dr1.` prefix)
2. Temporary `state → subscriber` binding from `connection.bindOAuthState(state)` or `POST http://127.0.0.1:8790/oauth-states`
3. If the route has exactly one subscriber, that subscriber
4. Otherwise `409` `{ "error": "oauth_unroutable" }`

If no subscribers are active, the router returns `404` `{ "error": "route_not_found" }`.

Internet-wide scanner probes (PHP leftovers such as `/phpinfo.php`, credential dumps such as `/credentials.json`, `/.env`, `/wp-admin`, `/_profiler`) get that same `404` immediately. They are not forwarded to subscribers, do not instantiate a Route Durable Object from the first path segment, and are not written to the inbound request log. Remaining paths with a `..` path-traversal segment after decode get that same cheap `404`. Real unmatched paths such as `/missing/api/hooks` are still logged. `GET /` and provider webhooks are not treated as probes.

Each delivery has a 10 second timeout and does not follow redirects. Public bodies and tunnel payloads are capped at 768 KiB (`413` `request_too_large` before the Worker buffers an oversized body).

Forwarded requests include:

- `X-Dev-Router-Route`
- `X-Dev-Router-Subscriber`
- `X-Dev-Router-Request-Id`
- `X-Dev-Router-Token` (per-connection forwarding credential; not `DEV_ROUTER_SECRET`)
- `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` when a client IP is present

The Worker does **not** send `X-Dev-Router-Secret`. Do not compare a hop header to the management bearer token.

Hop-by-hop headers (`connection`, `keep-alive`, `host`, `content-length`, and similar) are not forwarded. `Authorization` and `Cookie` are stripped on the inbound hop. Client-spoofed forwarding headers (`X-Original-URL`, `X-Rewrite-URL`, `X-Real-IP`, inbound `X-Forwarded-*`) are dropped; `X-Forwarded-For` is set from `CF-Connecting-IP` only. OAuth responses keep status, `Location`, and body; `Set-Cookie` is not copied onto the Worker host. Reverse-tunnel delivery also drops `Host` so the sidecar `fetch()` sets it from `localUrl` (for example `http://nomads-app-api.localhost:1355`); `X-Forwarded-Host` still carries the public host.

`_router` and `dashboard` are reserved path prefixes and are not valid `routeId` values.

Disconnected reverse-tunnel subscribers without an environment id are removed immediately when the WebSocket closes. With `--environment-id`, the subscriber parks for five minutes so pending OAuth bindings survive a reconnect. A second replica cannot take over a live environment id; that requires the current connection token. The Worker expires tunnels that miss pings.

## Replica mode

Every connected environment is meant to be a full copy. Webhook fan-out is useful only after **this** replica has completed the app’s OAuth to the provider and stored tokens locally. A webhook that then calls the provider will fail on orbs that skipped that step.

Inbound OAuth callbacks stay single-target (`wrapOAuthState` / `bindOAuthState` / control-server `POST /oauth-states`). Do not fan authorization codes. Each replica runs its own OAuth once; after that, all authenticated replicas can receive the same webhook.
