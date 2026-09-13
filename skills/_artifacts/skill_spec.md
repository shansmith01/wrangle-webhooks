# @wrangle/dev-router — Skill Spec

Shared Cloudflare ingress for ephemeral cloud development environments. One Worker plus Durable Objects; an npm sidecar registers environments and heartbeats. Skills target library version 0.1.0.

## Coverage and batch history

- **2026-09-14 / 0.1.0** — Initial batch for connect, deploy, and forwarding. Source: README plus `src/cli.ts`, `src/client.ts`, `src/worker.ts`, `src/forward.ts`, `src/shared.ts`, `wrangler.jsonc`. Skill files live beside their source docs under `skills/<task>/`. Checks: existing Vitest unit/worker tests for CLI, client, URL detection, and forwarding helpers; `intent validate`. Fresh-consumer Intent session not run (unverified). Remaining: registry publish name; optional dashboard skill.

## Domains

| Domain | Description | Skills |
| --- | --- | --- |
| Client connection | Register a cloud environment as a subscriber | connect |
| Shared Worker operations | Deploy and operate the ingress Worker | deploy |
| Ingress contract | Public URL mapping and forwarded request shape | forwarding |

## Skill Inventory

| Skill | Type | Domain | What it covers | Failure modes |
| --- | --- | --- | --- | --- |
| connect | core | client-connection | CLI, DevRouterClient, detection, HTTPS targets | 3 |
| deploy | lifecycle | worker-operations | wrangler deploy, secrets, types, dashboard | 3 |
| forwarding | core | ingress-contract | 202, headers, fan-out, route prefixes | 3 |

## Failure Mode Inventory

### connect (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | Treat client as request runtime | HIGH | skills/connect/connect.md | — |
| 2 | Pass http or credentialed target URLs | HIGH | src/shared.ts | — |
| 3 | npx public package name without install | HIGH | skills/connect/connect.md | — |

### deploy (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | Hardcode the management secret | CRITICAL | skills/deploy/deploy.md | — |
| 2 | Hand-write Env after binding changes | HIGH | wrangler.jsonc | — |
| 3 | Treat /dashboard as bearer-gated | HIGH | src/worker.ts | — |

### forwarding (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | Expect subscriber status on the public response | HIGH | src/worker.ts | — |
| 2 | Treat routeId as a secret | HIGH | skills/forwarding/forwarding.md | connect |
| 3 | Follow redirects at the router hop | MEDIUM | src/forward.ts | — |

## Tensions

| Tension | Skills | Agent implication |
| --- | --- | --- |
| Public prefix vs management auth | connect ↔ forwarding | Using --route as a credential |

## Cross-References

| From | To | Reason |
| --- | --- | --- |
| connect | forwarding | Subscriber app must match the wire contract |
| deploy | connect | Clients need the deployed origin |

## Subsystems & Reference Candidates

| Skill | Subsystems | Reference candidates |
| --- | --- | --- |
| connect | — | — |
| deploy | — | — |
| forwarding | — | — |

## Remaining Gaps

| Skill | Question | Status |
| --- | --- | --- |
| connect | Public npm name after registry publish | open |

## Recommended Skill File Structure

- **Core skills:** connect, forwarding
- **Framework skills:** none
- **Lifecycle skills:** deploy
- **Composition skills:** none
- **Reference files:** none — each skill stays next to its `*.md` source doc

## Composition Opportunities

| Library | Integration points | Composition skill needed? |
| --- | --- | --- |
| wrangler | deploy, types, secrets | no — covered by deploy |
