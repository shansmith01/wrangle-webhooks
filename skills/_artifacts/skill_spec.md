# @powerboard/dev-router — Skill Spec

Shared Cloudflare ingress for ephemeral cloud development environments. One Worker plus Durable Objects; an npm sidecar reverse-tunnels local HTTP servers (or optionally registers a public HTTPS target). Skills target library version 0.3.4.

## Coverage and batch history

- **2026-09-15 / 0.3.4** — Live `--environment-id` reclaim requires the sidecar connection token; parked reconnects still work after the socket closes. Dashboard HTML fetches `/dashboard/status` and is served with CSP `default-src 'none'` (no inlined subscriber JSON).
- **2026-09-15 / 0.3.3** — Control server listens before the tunnel is up; `GET /ready` 503 includes a safe `reason`. Connect skill documents local Portless development (supervisor `.env`, environment id, 401 vs closed 8790).
- **2026-09-15 / 0.3.2** — Reverse-tunnel `fetch()` derives `Host` from `localUrl` so virtual-host proxies such as Portless can route; `X-Forwarded-Host` keeps the public host.
- **2026-09-14 / 0.3.1** — Slim published deps (`ws` only), live WebSocket `/ready`, Amp services.yaml example, root vs named credentials, forwarding display URL.
- **2026-09-14 / 0.3.0** — Loopback control server (live WebSocket `/ready`), stable environment identity, root- and route-scoped join credentials, Amp services.yaml example, tunnel pong deadline.
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
| connect | core | client-connection | CLI, DevRouterClient, reverse tunnel, control server, Portless local dev, replica-mode OAuth prompt | 11 |
| deploy | lifecycle | worker-operations | wrangler deploy, secrets, types, dashboard cookie + CSP, WSS | 3 |
| forwarding | core | ingress-contract | webhook 202, OAuth proxy, replica credentials, headers, fan-out vs correlation | 6 |

## Failure Mode Inventory

### connect (11 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | Treat client as in-process middleware | HIGH | skills/connect/connect.md | — |
| 2 | Pass localhost as `--target` instead of `--local-url` | HIGH | src/shared.ts | — |
| 3 | npx public package name `dev-router` without install | HIGH | skills/connect/connect.md | — |
| 4 | Reserved route prefix | MEDIUM | src/shared.ts | — |
| 5 | Declare a new environment ready without OAuth | HIGH | skills/connect/connect.md | forwarding |
| 6 | Give every orb the operator secret | HIGH | src/credentials.ts | deploy |
| 7 | Treat /ready as connected from a parked subscriber id | HIGH | src/control-server.ts | — |
| 8 | Use a PID as `--environment-id` | HIGH | src/shared.ts | — |
| 9 | Reuse another replica’s live `--environment-id` | HIGH | src/durable-object.ts | — |
| 10 | `source .env` / `test -f` in the supervisor | HIGH | skills/connect/connect.md | — |
| 11 | Declare Portless success from a public 202 | HIGH | skills/forwarding/forwarding.md | forwarding |

### deploy (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | Hardcode the management secret | CRITICAL | skills/deploy/deploy.md | — |
| 2 | Hand-write Env after binding changes | HIGH | wrangler.jsonc | — |
| 3 | Gate /dashboard with the management bearer token | HIGH | src/worker.ts | — |

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
| Sidecar Connection vs app-generated OAuth state | connect ↔ forwarding | Binding state from the API without the loopback control server |

## Cross-References

| From | To | Reason |
| --- | --- | --- |
| connect | forwarding | Subscriber app must match the wire contract; replica OAuth before fan-out |
| deploy | connect | Clients need the deployed origin |

## Remaining Gaps

None for 0.3.4 live environment-id proof, dashboard cookie + CSP (no inlined subscriber JSON), 0.3.3 immediate control-server bind, `/ready` connection-state reason, Portless local-dev supervisor rules, or 0.3.2 reverse-tunnel Host-from-localUrl.

## Recommended Skill File Structure

- **Core skills:** connect, forwarding
- **Lifecycle skills:** deploy
- **Reference files:** none — each skill stays next to its `*.md` source doc
