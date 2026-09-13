# Request forwarding contract

Give external providers the **router** URL (`Public:` from `dev-router connect`). The Worker then delivers to each subscriber over reverse tunnel or by `fetch()`ing a public `https://` target.

`routeId` is an optional public path prefix, not a private identifier:

- omitted / empty → `https://dev-webhooks.example.com/oauth/callback`
- `my-web-app` → `https://dev-webhooks.example.com/my-web-app/oauth/callback`

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

Webhooks use **fan-out**. Every active subscriber receives a copy. The public caller gets `202 Accepted` `{ "accepted": true }` as soon as fan-out is accepted. Subscriber status codes are not propagated.

OAuth callbacks use **correlated single-target routing** and **return the subscriber response** (status, headers, body). That is required so authorization-code exchanges and redirects work. One `code` must go only to the subscriber that created its `state`.

A request is treated as OAuth when:

- the query or form body has `state` plus `code` or `error`, or
- the remaining path is `/oauth/callback` or `/auth/callback`

Routing order:

1. Signed `state` from `connection.wrapOAuthState()` (`dr1.` prefix)
2. Temporary `state → subscriber` binding from `connection.bindOAuthState(state)`
3. If the route has exactly one subscriber, that subscriber
4. Otherwise `409` `{ "error": "oauth_unroutable" }`

If no subscribers are active, the router returns `404` `{ "error": "route_not_found" }`.

Each delivery has a 10 second timeout and does not follow redirects. Tunnel payloads are capped at 768 KiB.

Forwarded requests include:

- `X-Dev-Router-Route`
- `X-Dev-Router-Subscriber`
- `X-Dev-Router-Request-Id`
- `X-Dev-Router-Token` (per-connection forwarding credential; not `DEV_ROUTER_SECRET`)
- `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` when a client IP is present

The Worker does **not** send `X-Dev-Router-Secret`. Do not compare a hop header to the management bearer token.

Hop-by-hop headers (`connection`, `keep-alive`, `host`, `content-length`, and similar) are not forwarded.

`_router` and `dashboard` are reserved path prefixes and are not valid `routeId` values.

Disconnected reverse-tunnel subscribers are removed immediately when the WebSocket closes.

## Replica mode

Every connected environment is meant to be a full copy. Webhook fan-out is useful only after **this** replica has completed the app’s OAuth to the provider and stored tokens locally. A webhook that then calls the provider will fail on orbs that skipped that step.

Inbound OAuth callbacks stay single-target (`wrapOAuthState` / `bindOAuthState`). Do not fan authorization codes. Each replica runs its own OAuth once; after that, all authenticated replicas can receive the same webhook.
