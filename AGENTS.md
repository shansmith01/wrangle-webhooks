# Agent notes

Versioned Agent Skills for `@wrangle/dev-router` live beside their source docs in `skills/`. Load only the skill that matches the current task:

- Connect sidecar / `DevRouterClient` → `skills/connect/SKILL.md`
- Deploy the shared Worker → `skills/deploy/SKILL.md`
- Public request contract / forwarded headers → `skills/forwarding/SKILL.md`

In consumer apps, discover installed package skills with `npx @tanstack/intent@latest list` after setting `package.json#intent.skills` (allowlist) and optional `intent.exclude`. Intent reads package files; it does not execute dependency code. Editor hooks are convenience, not a security boundary.
