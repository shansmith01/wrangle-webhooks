# @powerboard/dev-router — Skill Spec

Shared Cloudflare ingress for ephemeral cloud development environments. One Worker plus Durable Objects; an npm sidecar reverse-tunnels local HTTP servers (or optionally registers a public HTTPS target). Skills target library version 0.2.0.

## Coverage and batch history

- **2026-09-14 / 0.2.0** — Reverse-tunnel transport, OAuth subscriber responses, correlated `state` routing, replica-mode “OAuth this environment after connect” prompt, per-connection forward tokens, immediate tunnel disconnect.
- **2026-09-14 / 0.1.0** — Initial batch for connect, deploy, and forwarding.

## Domains

| Domain | Description | Skills |
| --- | --- | --- |
| Client connection | Register a cloud environment as a subscriber | connect |
| Shared Worker operations | Deploy and operate the ingress Worker | deploy |
| Ingress contract | Public URL mapping and forwarded request shape | forwarding |

## Skill Inventory

| Skill | Type | Domain | What it covers | Failure modes |
| --- | --- | --- | --- | --- |
| connect | core | client-connection | CLI, DevRouterClient, reverse tunnel, replica-mode OAuth prompt | 5 |
| deploy | lifecycle | worker-operations | wrangler deploy, secrets, types, dashboard, WSS | 3 |
| forwarding | core | ingress-contract | webhook 202, OAuth proxy, replica credentials, headers, fan-out vs correlation | 6 |

## Failure Mode Inventory

### connect (5 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | Treat client as in-process middleware | HIGH | skills/connect/connect.md | — |
| 2 | Pass localhost as `--target` instead of `--local-url` | HIGH | src/shared.ts | — |
| 3 | npx public package name `dev-router` without install | HIGH | skills/connect/connect.md | — |
| 4 | Reserved route prefix | MEDIUM | src/shared.ts | — |
| 5 | Declare a new environment ready without OAuth | HIGH | skills/connect/connect.md | forwarding |

### deploy (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | Hardcode the management secret | CRITICAL | skills/deploy/deploy.md | — |
| 2 | Hand-write Env after binding changes | HIGH | wrangler.jsonc | — |
| 3 | Treat /dashboard as bearer-gated | HIGH | src/worker.ts | — |

### forwarding (6 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | Expect subscriber status on webhook 202 | HIGH | src/worker.ts | — |
| 2 | Fan OAuth codes to every subscriber | HIGH | src/oauth-state.ts | connect |
| 3 | Treat routeId as a secret | HIGH | skills/forwarding/forwarding.md | connect |
| 4 | Point providers at the local URL instead of the router | HIGH | src/worker.ts | connect |
| 5 | Follow redirects at the router hop | MEDIUM | src/forward.ts | — |
| 6 | Fan-out webhooks to a replica that never OAuthed | HIGH | skills/forwarding/forwarding.md | connect |

## Tensions

| Tension | Skills | Agent implication |
| --- | --- | --- |
| Public prefix vs management auth | connect ↔ forwarding | Using --route as a credential |
| Replica OAuth vs webhook fan-out | connect ↔ forwarding | Connecting without prompting this environment to OAuth |

## Cross-References

| From | To | Reason |
| --- | --- | --- |
| connect | forwarding | Subscriber app must match the wire contract; replica OAuth before fan-out |
| deploy | connect | Clients need the deployed origin |

## Remaining Gaps

None for 0.2.0 reverse-tunnel + OAuth correlation.

## Recommended Skill File Structure

- **Core skills:** connect, forwarding
- **Lifecycle skills:** deploy
- **Reference files:** none — each skill stays next to its `*.md` source doc
