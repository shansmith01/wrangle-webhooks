---
name: forwarding
description: >
  Use when implementing the app that receives @wrangle/dev-router traffic, or
  when explaining public URLs, routeId prefixes, 202 Accepted, header
  stripping, X-Dev-Router-* headers, fan-out, 10s delivery timeout,
  route_not_found, or why the subscriber origin must be public https reachable
  from Cloudflare. Do not load this to install the sidecar or deploy the
  Worker.
metadata:
  purpose: Guidance for the public ingress path and what subscribers actually receive.
  type: core
  library: "@wrangle/dev-router"
  library_version: "0.1.0"
sources:
  - shansmith01/wrangle-webhooks:skills/forwarding/forwarding.md
  - shansmith01/wrangle-webhooks:src/worker.ts
  - shansmith01/wrangle-webhooks:src/forward.ts
  - shansmith01/wrangle-webhooks:src/shared.ts
---

# Request forwarding contract

The Worker is a generic HTTP fan-out. It does not special-case webhooks or OAuth. External services call the Worker; Cloudflare `fetch()`es each subscriber. The subscriber origin must be public `https://`, not an IDE-only port-forward.

## Setup

Public URL with a named route:

```text
POST https://dev-webhooks.example.com/project-a/api/hooks/payment?id=123
→ POST https://dev-a.example/api/hooks/payment?id=123
```

Empty route (root subscriber):

```text
POST https://dev-webhooks.example.com/api/hooks/payment?id=123
→ POST https://dev-a.example/api/hooks/payment?id=123
```

If a named route has active subscribers, it wins for that prefix. Otherwise the empty-route subscriber receives the full path.

## Core Patterns

### Accept 202 from the public caller

Fan-out runs in `waitUntil`. The public caller always gets `202` `{ "accepted": true }` once subscribers are found. Subscriber status codes are not propagated.

### Preserve method, body, query, and forwardable headers

Hop-by-hop headers (`host`, `content-length`, `connection`, …) are dropped. The Worker adds `X-Dev-Router-Route`, `X-Dev-Router-Subscriber`, `X-Dev-Router-Request-Id`, `X-Dev-Router-Secret`, `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` when a client IP exists.

### Timeouts and isolation

Each delivery uses a 10 second timeout and `redirect: "manual"`. `Promise.allSettled` means one failed subscriber does not cancel the others. Heartbeat every 60s; expire after 5 minutes.

### Empty route vs 404

No active subscribers → `404` `{ "error": "route_not_found" }`.

## Common Mistakes

### HIGH Expecting the subscriber status code on the public response

Wrong: treating a public `202` as proof the app returned `200`.

Correct: the public hop accepted fan-out. Inspect the subscriber app (or its logs) for the real status.

Source: `src/worker.ts` `handlePublic`

### HIGH Assuming a named prefix is a secret

Wrong: using an unguessable `routeId` as authentication.

Correct: `routeId` is a public path prefix. Management auth is the bearer secret. Forwarded requests include `X-Dev-Router-Secret` as an internal hop credential — validate that on the subscriber if you need to reject non-router traffic.

Source: `skills/forwarding/forwarding.md`, `src/forward.ts`

### HIGH Pointing providers at the tunnel URL instead of the router

Wrong: registering `https://random.trycloudflare.com/oauth/callback` with the OAuth app (unstable) or expecting deliveries to `http://127.0.0.1:3000`.

Correct: providers call `https://<router>/<routeId>/...`. The Worker forwards to the current `targetBaseUrl`. If that target is unreachable from Cloudflare, fan-out still returns `202` to the provider and the app never sees the request.

Source: `src/worker.ts`, `src/forward.ts`

### MEDIUM Using `_router` or `dashboard` as a routeId

Wrong:

```ts
await client.connect({ routeId: "_router", targetBaseUrl });
```

Correct: those prefixes are reserved for management and the dashboard. Pick another id or use `""`.

Source: `src/shared.ts`

### MEDIUM Expecting redirects to be followed toward the subscriber

Wrong: relying on the router to chase `301`/`302` from the target.

Correct: delivery uses `redirect: "manual"` and a 10s timeout.

Source: `src/forward.ts`

## Completion

A live subscriber receives the stripped path under its `targetBaseUrl`, including query string. The public client has `202`. If nothing is registered, the public client has `404` `route_not_found`.
