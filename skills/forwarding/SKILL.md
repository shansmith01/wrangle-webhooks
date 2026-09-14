---
name: forwarding
description: >
  Use when implementing the app that receives @powerboard/dev-router traffic, or
  when explaining public URLs, routeId prefixes, webhook 202 fan-out, OAuth
  subscriber responses, replica mode (OAuth each new environment before
  webhook follow-up), state correlation, header stripping, X-Dev-Router-Token,
  reverse tunnels, 10s delivery timeout, or route_not_found. Do not load this
  to install the sidecar or deploy the Worker.
metadata:
  purpose: Guidance for the public ingress path and what subscribers actually receive.
  type: core
  library: "@powerboard/dev-router"
  library_version: "0.3.4"
sources:
  - shansmith01/wrangle-webhooks:skills/forwarding/forwarding.md
  - shansmith01/wrangle-webhooks:src/worker.ts
  - shansmith01/wrangle-webhooks:src/forward.ts
  - shansmith01/wrangle-webhooks:src/durable-object.ts
  - shansmith01/wrangle-webhooks:src/oauth-state.ts
  - shansmith01/wrangle-webhooks:src/shared.ts
---

# Request forwarding contract

External services call the Worker. Webhooks fan out to every subscriber and the public caller gets `202`. OAuth callbacks are routed to one subscriber and that subscriber’s response is returned. Delivery is either a reverse-tunnel WebSocket or `fetch()` to a public `https://` target.

## Setup

Public URL with a named route:

```text
POST https://dev-webhooks.example.com/project-a/api/hooks/payment?id=123
→ POST <subscriber>/api/hooks/payment?id=123
```

Empty route (root subscriber):

```text
POST https://dev-webhooks.example.com/api/hooks/payment?id=123
→ POST <subscriber>/api/hooks/payment?id=123
```

If a named route has active subscribers, it wins for that prefix. Otherwise the empty-route subscriber receives the full path.

## Core Patterns

### Accept 202 only for webhook fan-out

Fan-out runs in `waitUntil`. The public caller gets `202` `{ "accepted": true }` once subscribers are found. That is not proof any replica handled the request. Confirm delivery in each subscriber’s logs. Subscriber status codes are not propagated for webhooks.

### Return the subscriber response for OAuth

OAuth callbacks (`state` plus `code`/`error`, or `/oauth/callback` / `/auth/callback`) wait for one subscriber and return its status, `Location`, and body. `Set-Cookie` is not copied onto the Worker host. Correlate with `wrapOAuthState()`, `bindOAuthState()`, or `POST http://127.0.0.1:8790/oauth-states` from the app process. A single subscriber on the route is enough. Multiple subscribers without correlation return `409 oauth_unroutable`.

### Preserve method, body, query, and forwardable headers

Hop-by-hop headers are dropped, including `Authorization` and `Cookie`. OAuth responses still return status, `Location`, and body; `Set-Cookie` is not copied onto the Worker host. Reverse-tunnel `fetch()` derives `Host` from `localUrl`; `X-Forwarded-Host` keeps the public host so virtual-host proxies such as Portless can route. The Worker adds `X-Dev-Router-Route`, `X-Dev-Router-Subscriber`, `X-Dev-Router-Request-Id`, `X-Dev-Router-Token` (per-connection credential), and `X-Forwarded-*` when a client IP exists. It does not send `X-Dev-Router-Secret`.

### Timeouts and isolation

Each delivery uses a 10 second timeout and `redirect: "manual"`. `Promise.allSettled` means one failed webhook subscriber does not cancel the others. Anonymous tunnel sockets are removed as soon as they disconnect. Environment-identified tunnels park for five minutes so OAuth bindings survive a reconnect. A live environment id cannot be taken over without that sidecar’s connection token.

### Replica mode

Webhook fan-out assumes every subscriber can do authenticated follow-up. That is only true after this environment has completed OAuth and stored tokens. Load `connect` when bringing up a new orb so the operator is prompted to OAuth-register here. Authorization codes still go to one subscriber; each replica OAuths separately.

## Common Mistakes

### HIGH Expecting a subscriber status on webhook fan-out

Wrong: treating a public `202` as proof the app returned `200`, or as proof every replica received the webhook.

Correct: webhook fan-out only accepts the public hop. Inspect **each** subscriber’s logs for the real status. OAuth is the opposite: the public response **is** the subscriber response.

Source: `src/worker.ts` `handlePublic`

### HIGH Fanning an OAuth authorization code to every subscriber

Wrong: relying on webhook-style fan-out for `/oauth/callback`.

Correct: wrap or bind `state` so the code reaches only the orb that started the flow. The app process POSTs `/oauth-states` on the sidecar control server.

Source: `src/oauth-state.ts`, `src/durable-object.ts`, `src/control-server.ts`

### HIGH Assuming a named prefix is a secret

Wrong: using an unguessable `routeId` as authentication.

Correct: `routeId` is a public path prefix. Management auth is the bearer secret. Validate `X-Dev-Router-Token` on the subscriber if you need to reject non-router traffic.

Source: `skills/forwarding/forwarding.md`, `src/forward.ts`

### HIGH Pointing providers at the local URL instead of the router

Wrong: registering `http://127.0.0.1:3000/oauth/callback` with the OAuth app.

Correct: providers call `https://<router>/<routeId>/...`. The sidecar forwards to the local server.

Source: `src/worker.ts`, `src/forward.ts`

### MEDIUM Expecting redirects to be followed toward the subscriber

Wrong: relying on the router to chase `301`/`302` from the target.

Correct: delivery uses `redirect: "manual"` and a 10s timeout. OAuth 302s are returned to the public caller.

Source: `src/forward.ts`

### HIGH Treating webhook fan-out as ready before this replica has OAuth tokens

Wrong: connecting a new orb and expecting provider follow-up to succeed.

Correct: this environment must complete the app’s OAuth first. Other replicas’ tokens do not transfer. Until then, skip calling it webhook-ready.

Source: `skills/forwarding/forwarding.md`, `skills/connect/connect.md`

## Completion

A live subscriber receives the stripped path, including query string. Webhook callers see `202`. OAuth callers see the subscriber response. If nothing is registered, the public client has `404` `route_not_found`.

If this is a **new** environment, also say that replica mode is incomplete until the operator OAuth-registers with the third-party provider here. Point them at the router Public URL as the redirect URI.
