# Webhook fan-out filters

Status: proposed  
Library: `@powerboard/dev-router`  
Depends on: current webhook `202` fan-out, admin OAuth callback-path allowlist, dashboard session cookie

## Goal

Operators can keep a stable public URL and still control **which webhook remaining paths** each subscriber receives. Default stays today’s behavior: every live subscriber on the route gets every webhook. OAuth reverse-proxy is unchanged.

## Non-goals (v1)

- Regex, globs, query-string, header, or HTTP-method matching
- CLI flags for path allow/skip (`--only-path` / `--skip-path`)
- Filtering or mutating OAuth callback delivery
- Changing the public webhook contract (`202` `{ "accepted": true }` while subscribers exist)
- Using `routeId` as a substitute for these filters (named routes remain a different public URL)

## Behavior

Matching uses the **remaining path** after `routeId` is stripped (the same path the subscriber already receives). Query string and fragment are ignored.

Prefix match with a **path-segment boundary**, after the same trailing-slash normalize used for OAuth callback paths. A prefix matches when the remaining path equals the prefix, or starts with `prefix + "/"`:

| Rule prefix | `/webhooks/mews` | `/webhooks/mews/x` | `/webhooks/mews-backup` | `/webhooks` | `/webhook` |
| --- | --- | --- | --- | --- | --- |
| `/webhooks/mews` | yes | yes | no | no | no |
| `/webhooks` | yes | yes | yes | yes | no |

`/` is **not** a valid path rule (use deny-all instead).

### Delivery decision (per subscriber, webhook fan-out only)

```
if route.denyAllWebhooks: skip
if subscriber.acceptWebhooks === false: skip
applicable = rules for this route where environmentId is null
             OR environmentId === subscriber.environmentId
allows = applicable where mode === "allow"
denies = applicable where mode === "deny"
if allows is non-empty AND path matches none of them: skip
if path matches any deny: skip
else: deliver
```

Anonymous subscribers (no `environmentId`) only see rules with `environmentId === null`.

If every subscriber is skipped, the public caller still gets `202` `{ "accepted": true }` as long as the route had at least one live subscriber. That matches today’s “202 is not delivery proof” contract. No subscriber on the route remains `404` `route_not_found`.

Scanner probes, `..` remaining paths, oversized bodies, and OAuth classification still run **before** these filters.

### Deny all

Two independent switches; **either** skips webhook delivery:

| Surface | Scope | Persistence |
| --- | --- | --- |
| Dashboard / operator API `denyAllWebhooks` | Whole route | Router index (survives zero subscribers) |
| CLI `--no-webhooks` / `DEV_ROUTER_NO_WEBHOOKS` | This subscriber | Subscriber row; reconnect with `--environment-id` overwrites the flag from the new connect |

OAuth callbacks on an allowlisted path still proxy to the correlated subscriber even when both switches are on.

## Data

### Router index (durable, operator-owned)

Same Durable Object as OAuth callback paths. Minted route join tokens **cannot** mutate these settings.

Route settings (one row per `route_id`, including `""` for root):

- `deny_all_webhooks` INTEGER NOT NULL DEFAULT 0

Path rules (max **32** per route):

- `route_id` TEXT NOT NULL
- `mode` TEXT NOT NULL (`allow` \| `deny`)
- `remaining_path` TEXT NOT NULL
- `environment_id` TEXT NULL
- `created_at` INTEGER NOT NULL
- PRIMARY KEY `(route_id, mode, remaining_path, environment_id)` with NULL environment stored as `''`

Path validation (reject → do not store):

- Remaining path only: starts with `/`, no scheme, `//`, query, hash, glob `*`, `..`, scanner-probe shape
- Length 1–256 after normalize; trailing slashes stripped
- Not exactly `/`
- `environment_id` empty or `isAllowedEnvironmentId`

### Subscriber row (Route Durable Object)

- `accept_webhooks` INTEGER NOT NULL DEFAULT 1

Set at public-target `POST` register and tunnel WebSocket open. Heartbeat must **not** reset it. Environment-id reclaim must apply the **new** connect value.

## Surfaces

### Dashboard (password cookie, `Path=/dashboard`)

New section **Webhook fan-out**, same POST + 303 pattern as OAuth callback paths. Do not put editors in the live-connections table (5s refresh).

- Checkbox **Deny all webhook fan-out** for a route (empty route id = root)
- Rule table: route, mode (`only` / `skip`), remaining path, environment id or “all”, remove
- Add form: route id, mode, remaining path, optional environment id
- Live connection rows show a read-only badge when `acceptWebhooks` is false (`webhooks off`)
- Inbound table adds **Delivered** (`deliveredSubscriberCount`) next to **Subscribers**
- HTML still fetches `/dashboard/status`; no subscriber JSON inlined; CSP unchanged
- Forms do not return secrets, forward tokens, or connection tokens

Dashboard POST targets:

- `POST /dashboard/webhook-fanout` — upsert route `denyAllWebhooks` (`routeId`, `denyAllWebhooks=on|off`)
- `POST /dashboard/webhook-fanout-rules` — add rule
- `POST /dashboard/webhook-fanout-rules/delete` — remove rule

Invalid form bodies redirect to `/dashboard` with no write (same as invalid OAuth path forms).

### Operator API (bearer `DEV_ROUTER_SECRET` only)

Root and named-route twins, matching OAuth callback paths:

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/_router/webhook-fanout` or `/_router/routes/:routeId/webhook-fanout` | — |
| `PUT` | same | `{ "denyAllWebhooks": true }` |
| `GET` | `/_router/webhook-fanout-rules` or `/_router/routes/:routeId/webhook-fanout-rules` | — |
| `PUT` | same | `{ "mode": "allow" \| "deny", "path": "/webhooks/mews", "environmentId"?: string }` |
| `DELETE` | same | JSON `path`+`mode`+optional `environmentId`, or query equivalents |

Join credentials: `401` / existing unauthorized management response. They may set **their own** `acceptWebhooks` on register/tunnel only.

Error codes (literal strings):

- `invalid_json`
- `invalid_webhook_filter_path`
- `invalid_webhook_fanout_mode`
- `invalid_environment_id`
- `webhook_fanout_rule_not_found`
- `webhook_fanout_rule_limit`

GET settings shape:

```json
{ "routeId": "nomads", "denyAllWebhooks": false, "rules": [] }
```

### CLI / client

```bash
npx dev-router connect --local-url http://127.0.0.1:3000 --no-webhooks
```

- Flag: `--no-webhooks`
- Env: `DEV_ROUTER_NO_WEBHOOKS` accepted as `1`, `true`, `yes` (case-insensitive); unset or any other value = accept webhooks
- Public-target register JSON includes `acceptWebhooks: false` when set
- Tunnel URL includes `acceptWebhooks=0` when set (omit param or `1` = accept)
- After connect, print `Webhooks: denied (this subscriber)` when opted out
- `ConnectOptions.acceptWebhooks?: boolean` (default true)
- Help text and `skills/connect` document the flag

No CLI for path rules in v1.

## Code map (discoverable names)

| Concept | Home |
| --- | --- |
| Prefix match + subscriber selection | `src/webhook-path-filter.ts` — `remainingPathMatchesWebhookPrefix`, `selectWebhookFanoutSubscribers` |
| Path / rule validation | `src/webhook-filter-path.ts` — `validateWebhookFilterPath`, `normalizeWebhookFilterPath` |
| Index SQL | `src/webhook-fanout-settings-storage.ts` |
| Index RPC | `src/router-index.ts` |
| `acceptWebhooks` persist | `src/durable-object.ts` subscriber migration + `fanOut` |
| Apply before `deliver` | `RouteDurableObject.fanOut` reads index settings, then `selectWebhookFanoutSubscribers` |
| Inbound delivered count | `src/inbound-log.ts` field `deliveredSubscriberCount` (OAuth proxied = 1, else 0) |
| Dashboard UI | `src/dashboard.ts`, `src/dashboard-http.ts` |
| Operator HTTP | `src/management-http.ts` |
| CLI / client | `src/cli.ts`, `src/client.ts`, `src/dev-router-types.ts`, `src/tunnel-protocol.ts` |

`fanOut` must not `fetch()` or send a tunnel `request` frame for a skipped subscriber. Filter **before** delivery, not in the sidecar.

Record inbound metadata **after** computing the filtered list (still before `waitUntil` delivery). `subscriberCount` stays “live subscribers on the route” (why 202 fired). `deliveredSubscriberCount` is how many passed filters.

## Docs to update

- `README.md` (webhook paragraph, dashboard, CLI env table)
- `skills/forwarding/forwarding.md` + `SKILL.md` (202 still not delivery proof; filters; deny-all)
- `skills/connect/connect.md` + `SKILL.md` (`--no-webhooks`, replica-mode mute)
- `skills/deploy/deploy.md` if dashboard section lists operator settings
- `skills/_artifacts/skill_spec.md` coverage note

## Test plan (validation)

Run:

```bash
npx vitest run --config vitest.config.ts
npx vitest run --config vitest.worker.config.ts
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.worker.json
npx intent validate --check
```

New unit file: `test/unit/webhook-path-filter.test.ts`  
New unit file: `test/unit/webhook-filter-path.test.ts`  
Worker cases: `test/worker/router.test.ts`  
CLI/client: `test/unit/cli-command.test.ts` (or a dedicated `test/unit/cli-no-webhooks.test.ts` if parsing moves out of `cli.ts`), `test/unit/client.test.ts`

Existing fan-out, OAuth, scanner, and inbound-log tests must keep passing with empty settings.

---

## Acceptance criteria

Each criterion is false until a test (or named command) observes the listed outcome. IDs are stable; use them in test titles (`AC-01 …`).

### Default and public contract

**AC-01 — Empty settings fan out to every subscriber**  
Given two public-target subscribers on route `fanout-route` and no webhook settings.  
When `POST /fanout-route/api/hooks/payment`.  
Then status `202`, body `{ "accepted": true }`, and **both** targets receive the remaining path (existing fan-out intercepts).  
Validate: existing `accepts a public request and fans out to every subscriber independently` plus empty-settings fixture.

**AC-02 — Filtered-to-zero still 202**  
Given one live subscriber and route `denyAllWebhooks: true`.  
When `POST /<route>/api/hooks/payment`.  
Then `202` `{ "accepted": true }`, and the subscriber origin has **no** matching `fetchMock` intercept (afterEach `assertNoPendingInterceptors` would fail if one was registered and unused; register **no** intercept for that origin).  
Validate: worker test named `AC-02`.

**AC-03 — No subscribers still 404**  
Given deny-all and/or path rules on a route with zero live subscribers.  
When any public webhook hits that route.  
Then `404` `{ "error": "route_not_found" }`. Filters must not keep a route “open” without subscribers.  
Validate: worker test `AC-03`.

**AC-04 — Scanner probes still skip fan-out and inbound log**  
Given a live subscriber and deny-all off.  
When `GET /phpinfo.php` (or other `isScannerProbePath`).  
Then `404` `route_not_found`, no delivery, inbound log does not contain that path.  
Validate: existing scanner tests still pass.

### Path matching (unit)

**AC-05 — Segment-boundary prefix**  
`remainingPathMatchesWebhookPrefix` is true for `/webhooks/mews` vs `/webhooks/mews` and `/webhooks/mews/x`, false vs `/webhooks/mews-backup` and `/webhooks/mew`.  
Validate: `test/unit/webhook-path-filter.test.ts`.

**AC-06 — Normalize trailing slash and ignore query**  
`/webhooks/mews/` and `/webhooks/mews?x=1` match prefix `/webhooks/mews`.  
Validate: unit tests on the helper used by `selectWebhookFanoutSubscribers` (pass remaining path + search separately; search must not affect the match).

**AC-07 — Reject illegal path rules**  
`validateWebhookFilterPath` returns `null` for `""`, `/`, `http://evil`, `//x`, `/a?b`, `/a#b`, `/a*`, `/foo/../bar`, and scanner-probe paths. Accepts `/webhooks/mews`.  
Validate: `test/unit/webhook-filter-path.test.ts`.

### Allow / skip rules

**AC-08 — Allowlist: only matching subscriber paths deliver**  
Given route rule `{ mode: "allow", path: "/webhooks/mews" }` (all environments).  
When `POST /<route>/webhooks/mews` → subscriber **is** fetched.  
When `POST /<route>/webhooks/stripe` → `202`, subscriber **not** fetched.  
Validate: worker `AC-08`.

**AC-09 — Denylist: matching prefix is skipped, others deliver**  
Given `{ mode: "deny", path: "/webhooks/stripe" }`.  
When `POST /<route>/webhooks/stripe/invoice` → not fetched.  
When `POST /<route>/webhooks/mews` → fetched.  
Validate: worker `AC-09`.

**AC-10 — Allow then deny**  
Given allow `/webhooks` and deny `/webhooks/stripe` (both all-environments).  
Then `/webhooks/mews` delivers, `/webhooks/stripe` skips, `/api/other` skips.  
Validate: unit `selectWebhookFanoutSubscribers` table test `AC-10`.

**AC-11 — Environment-scoped rule**  
Given subscribers `env-a` and `env-b`, rule allow `/webhooks/mews` with `environmentId: "env-a"`.  
When `POST /<route>/webhooks/mews` → only `env-a` is fetched.  
When `POST /<route>/webhooks/stripe` → neither fetched (env-a fails allowlist; env-b has no allow rules so still receives **unless** we treat “any allow rule on the route” as global).  
**Locked interpretation:** allow rules in `applicable` only. `env-b` has zero applicable allow rules, so it still receives `/webhooks/stripe` and `/webhooks/mews`. Scoped allow is **opt-in for that environment**, not a route-wide allowlist.  
Validate: worker `AC-11` with two public targets and distinct `environmentId`s.

**AC-12 — Anonymous subscriber ignores env-scoped rules**  
Given an env-scoped deny `/webhooks/stripe` for `env-a` and an anonymous subscriber.  
When `POST /<route>/webhooks/stripe` → anonymous **is** fetched.  
Validate: worker `AC-12`.

**AC-13 — Rule cap**  
Given 32 rules on a route.  
When `PUT` a 33rd.  
Then `400` `{ "error": "webhook_fanout_rule_limit" }`.  
Validate: worker `AC-13`.

### Deny all (route) and `--no-webhooks` (subscriber)

**AC-14 — Route deny-all skips every subscriber**  
Given two live subscribers and `PUT` `{ "denyAllWebhooks": true }`.  
When a webhook arrives.  
Then `202`, neither origin fetched. Path allow rules on that route have no effect.  
Validate: worker `AC-14`.

**AC-15 — Unchecking deny-all restores default fan-out**  
Given AC-14, then `PUT` `{ "denyAllWebhooks": false }`.  
When the same webhook arrives.  
Then both origins are fetched.  
Validate: worker `AC-15`.

**AC-16 — Settings survive zero subscribers**  
Given `denyAllWebhooks: true` and a path rule, then last subscriber disconnects (`204`).  
When `GET` webhook-fanout settings.  
Then `denyAllWebhooks` is still true and the rule is still listed.  
When a new subscriber connects and a webhook arrives.  
Then it is not fetched.  
Validate: worker `AC-16`.

**AC-17 — Subscriber `--no-webhooks` skips only that client**  
Given subscriber A registered with `acceptWebhooks: false` and subscriber B default.  
When a webhook arrives.  
Then `202`, only B is fetched.  
Validate: worker `AC-17` (public-target register body) **and** tunnel connect with `acceptWebhooks=0` if a tunnel worker test helper exists; otherwise public-target is required and tunnel parse is a unit test on `managementTunnelPath` / Durable Object query param.

**AC-18 — Environment reclaim overwrites the flag**  
Given parked `environmentId: "orb-1"` with `acceptWebhooks: false`, then reconnect same id with `acceptWebhooks: true`.  
When a webhook arrives.  
Then that subscriber **is** fetched. Reverse (true then false) is not fetched.  
Validate: worker `AC-18`.

**AC-19 — Heartbeat does not reset `acceptWebhooks`**  
Given `acceptWebhooks: false`, then successful heartbeat.  
When a webhook arrives.  
Then still not fetched.  
Validate: worker `AC-19`.

**AC-20 — CLI wiring**  
Given `--no-webhooks` or `DEV_ROUTER_NO_WEBHOOKS=true`.  
Then `ConnectOptions` / register JSON / tunnel query communicate `acceptWebhooks: false`.  
Given env unset and no flag.  
Then the field is omitted or true (Worker default accept).  
Validate: unit tests; do not require a live Worker for parse-only cases.

**AC-21 — Combined mute**  
Given route deny-all **or** subscriber opt-out (matrix of three: route only, subscriber only, both).  
Then that subscriber is not fetched. Omitted case (neither) is fetched.  
Validate: unit `selectWebhookFanoutSubscribers` `AC-21`.

### OAuth isolation

**AC-22 — Deny-all does not block allowlisted OAuth**  
Given `denyAllWebhooks: true`, allowlisted `/oauth/callback`, one subscriber.  
When `GET /<route>/oauth/callback?code=123`.  
Then subscriber **is** fetched and the public response is the subscriber response (not `202`).  
Validate: worker `AC-22` (clone existing OAuth success test + deny-all).

**AC-23 — `--no-webhooks` subscriber still receives correlated OAuth**  
Given that subscriber opted out of webhooks, callback path allowlisted, `code` present.  
Then OAuth still proxies to it.  
Validate: worker `AC-23`.

**AC-24 — Unregistered heuristic callback still 404, no fan-out**  
Given deny-all off, no allowlist, path `/oauth/callback?code=1`.  
Then `404` `oauth_callback_not_registered`, no webhook delivery.  
Validate: existing test still passes.

### Dashboard

**AC-25 — Status JSON includes settings**  
Given a dashboard session.  
When `GET /dashboard/status`.  
Then JSON includes `webhookFanout: { denyAllWebhooks, rules }` (or equivalent documented shape) and each subscriber includes `acceptWebhooks`. No `forwardToken`, `connectionToken`, or `DEV_ROUTER_SECRET`.  
Validate: worker dashboard tests.

**AC-26 — Checkbox persists via dashboard POST**  
Given dashboard cookie.  
When `POST /dashboard/webhook-fanout` with `routeId` + `denyAllWebhooks=on`.  
Then `303` to `/dashboard`, and `GET /dashboard/status` shows `denyAllWebhooks: true` for that route. Repeat with `off` → false.  
Validate: worker test mirroring OAuth callback-path form test.

**AC-27 — Add and remove path rule via dashboard**  
`POST /dashboard/webhook-fanout-rules` then status lists the rule; delete POST removes it. Invalid path: 303, no new rule.  
Validate: worker tests.

**AC-28 — Unauthenticated dashboard writes fail**  
Without cookie, POSTs to the new dashboard paths return the existing unauthorized dashboard response (not a write).  
Validate: worker test.

**AC-29 — HTML does not inline subscriber JSON**  
`GET /dashboard` still has CSP `default-src 'none'` and no inlined `sub_` payload in a script tag. Page still loads `/dashboard/status`.  
Validate: existing dashboard HTML test still passes; grep new templates for the same constraint.

**AC-30 — Inbound delivered count**  
Given one subscriber and a skip rule that matches the request.  
When webhook `202`.  
Then inbound row: `kind: "webhook"`, `result: "accepted"`, `status: 202`, `subscriberCount: 1`, `deliveredSubscriberCount: 0`, path without query, no body.  
Given a delivering webhook to that one subscriber.  
Then `deliveredSubscriberCount: 1`.  
Validate: worker inbound-log tests; existing “no SHOULD-NOT-LOG” test still passes.

### Operator API auth

**AC-31 — Operator secret can CRUD**  
`Authorization: Bearer <DEV_ROUTER_SECRET>` PUT/GET/DELETE settings and rules succeed with the JSON shapes above.  
Validate: worker tests (root and named route).

**AC-32 — Join token cannot mutate route settings**  
Given a minted route credential.  
When PUT/DELETE webhook-fanout or webhook-fanout-rules.  
Then unauthorized (same status/body as minted token vs OAuth callback-path PUT).  
Validate: clone the existing minted-token OAuth allowlist denial test.

**AC-33 — Join token can set own `acceptWebhooks`**  
Register/tunnel with join token and `acceptWebhooks: false` succeeds; that subscriber is skipped on fan-out.  
Validate: worker `AC-33`.

### Docs / skills

**AC-34 — Public docs name the contract**  
`README.md`, `skills/forwarding/forwarding.md`, and `skills/connect/connect.md` state: default accept all; dashboard path rules; route deny-all checkbox; `--no-webhooks`; 202 is not delivery proof; OAuth unaffected.  
Validate: `npx intent validate --check` and review those files in the PR.

**AC-35 — Typecheck**  
`npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.worker.json` exit 0.

## Open points (locked for v1)

1. Path CLI flags are **out**. Dashboard + operator API only.  
2. Scoped **allow** is opt-in for that environment (AC-11), not a route-wide allowlist.  
3. `deliveredSubscriberCount` is a new inbound-log column; `subscriberCount` meaning does not change.  
4. Per-connection dashboard mute is **out** (CLI + route checkbox only).
