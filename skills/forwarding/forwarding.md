# Request forwarding contract

The router is generic. It does not distinguish webhooks, OAuth callbacks, or any other HTTP request.

`routeId` is an optional public path prefix, not a private identifier:

- omitted / empty → `https://dev-webhooks.example.com/oauth/callback`
- `my-web-app` → `https://dev-webhooks.example.com/my-web-app/oauth/callback`

If a named route has active subscribers, it wins for that prefix. Otherwise an empty-route subscriber receives the full path.

Incoming with a route prefix:

```text
POST https://dev-webhooks.example.com/project-a/api/hooks/payment?id=123
```

Forwarded:

```text
POST https://dev-a.example/api/hooks/payment?id=123
```

Incoming with an empty route:

```text
POST https://dev-webhooks.example.com/api/hooks/payment?id=123
```

Forwarded:

```text
POST https://dev-a.example/api/hooks/payment?id=123
```

The original method, raw body, query string, and relevant headers are preserved. The public caller receives `202 Accepted` as soon as fan-out is accepted. Subscriber status codes are not propagated.

If a route has no active subscribers, the router returns `404` with `{ "error": "route_not_found" }`.

Heartbeats every 60 seconds keep a subscriber alive. Expiry is 5 minutes. One failed subscriber does not prevent delivery attempts to the others. Each delivery has a 10 second timeout and does not follow redirects.

Forwarded requests include:

- `X-Dev-Router-Route`
- `X-Dev-Router-Subscriber`
- `X-Dev-Router-Request-Id`
- `X-Dev-Router-Secret` (the Worker secret; treat as an internal hop credential)
- `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` when a client IP is present

Hop-by-hop headers (`connection`, `keep-alive`, `host`, `content-length`, and similar) are not forwarded.

`_router` and `dashboard` are reserved path prefixes and are not valid `routeId` values.
