# agent-guardrails

A safe operating model for pointing an AI agent (Claude Code) at this chant repo:
the agent produces reviewed diffs, a human deploys.

These are **sample files**. The repo gitignores `.claude/` and `CLAUDE.md`, so they
live here, tracked and visible. Copy them into place to activate:

```bash
cd examples/getting-started
mkdir -p .claude/skills/scaffold-stack .claude/skills/drift-check
cp agent-guardrails/settings.json          .claude/settings.json
cp agent-guardrails/agent-instructions.md  CLAUDE.md
cp agent-guardrails/skills/scaffold-stack.md .claude/skills/scaffold-stack/SKILL.md
cp agent-guardrails/skills/drift-check.md     .claude/skills/drift-check/SKILL.md
```

## What each piece does

- `settings.json` — permission tiers. Build, lint, and `lifecycle plan` are
  allowed (pure, no credentials). Drift and reconcile are ask-first. The deploy
  Ops (`deploy`, `deploy-gated`, `apply`), their approval signal, and
  `kubectl apply` / `delete` are denied to the agent. A PostToolUse hook runs
  `chant lint` on every edit.
- `agent-instructions.md` — standing facts: the loop, the static subset, what not
  to run. Becomes `CLAUDE.md`.
- `skills/` — `scaffold-stack` and `drift-check`.

The guardrails constrain an agent working in this directory. You, running the
tutorial by hand, still run the deploy steps. The point is that chant's build path
needs no credentials, so the agent's whole authoring loop can run sandboxed, and
the one dangerous verb — apply — stays with a human behind a gate.
