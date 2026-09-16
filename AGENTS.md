# Agent notes

Versioned Agent Skills for `@powerboard/dev-router` live beside their source docs in `skills/`. Load only the skill that matches the current task:

- Connect sidecar / `DevRouterClient` (including remote cloud environments, replica-mode OAuth prompt) → `skills/connect/SKILL.md`
- Deploy the shared Worker → `skills/deploy/SKILL.md`
- Public request contract / forwarded headers → `skills/forwarding/SKILL.md`

When writing or renaming code in this repository, also load `.agents/skills/write-discoverable-code/SKILL.md`. Cursor, Codex, and Amp all discover that project skill from `.agents/skills/`.

Public operator and consumer instructions are in `README.md`. The npm tarball is the client; the Worker is deployed from this repository.

In consumer apps, discover installed package skills with `npx @tanstack/intent@latest list` after setting `package.json#intent.skills` (allowlist) and optional `intent.exclude`. Intent reads package files; it does not execute dependency code. Editor hooks are convenience, not a security boundary.
