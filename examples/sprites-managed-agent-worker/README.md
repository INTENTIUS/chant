# sprites-managed-agent-worker

Run a [Claude Managed Agents](https://docs.sprites.dev/integrations/claude-managed-agents/)
session inside a per-session [Sprite](https://sprites.dev) — Fly.io's stateful,
checkpointable sandbox.

Anthropic runs the agent loop and the model and queues work items. A **worker**
on your infrastructure claims each item and spawns a Sprite that executes the
tools, so the agent's filesystem and network egress never leave your account.
The org API key stays with the worker — only a scoped environment key reaches
the Sprite.

This example is the **per-session unit** the worker runs once per claimed work
item. `chant run managed-agent-session` drives one session end-to-end against the
in-process emulator, with no Anthropic key and no Fly account.

## What one session does

| Phase | Activity | Point |
|-------|----------|-------|
| Create | `spriteCreate` | spawn the per-session sandbox |
| Secure | `spriteApplyNetworkPolicy` | egress allowlist — Anthropic + registries only, deny the rest |
| Hold | `spriteTaskCreate` | keep-alive task so the Sprite will not pause mid-session |
| Stage | `spriteWriteFile` | the runner env-contract, written to a file (never process args) |
| Runner | `spriteApplyServices` | Anthropic's runner as a supervised service, started |
| Run | `spriteExec` | the session's tool calls execute in the sandbox |
| Release / Destroy | `spriteTaskRelease` / `spriteDestroy` | free the hold and tear down |

`onFailure` releases the hold and destroys the Sprite, so a stuck session never
leaves a paused-but-billed sandbox behind.

## The keep-alive hold

A task holds the Sprite active while the session runs; without it the Sprite
pauses after a short idle window. A task's `expire` is capped at one hour, so a
session that can run longer refreshes its hold on a shorter interval (the docs
recommend a 5-minute expiry refreshed every 60 seconds). That refresh loop lives
in the long-running worker around this Op — `spriteTaskRefresh` is the building
block. This bounded session takes a single 5-minute hold and releases it at the
end.

## Faking the work queue

The Sprite side is real and runs against the emulator. The **Anthropic
work-queue side** (the environments API, work items) has no emulator, so this
example does not poll it — the session id is a static string, as if a single
work item had been claimed. A production worker replaces that with a poll or
webhook against `client.beta.environments.work`, spawning one Sprite per session
id. See the integration docs linked above.

## Run it

```bash
npm install

# Against the in-process emulator (no key, no Fly account).
export SPRITES_BASE_URL=http://127.0.0.1:9000
chant run managed-agent-session
```

```bash
# Against real Sprites + real Managed Agents: drop the override, set the tokens.
unset SPRITES_BASE_URL
export SPRITES_API_TOKEN=...
export ANTHROPIC_ENVIRONMENT_KEY=...   # scoped env key, not your org API key
chant run managed-agent-session
```

The activities, the emulator, and this session's shape have offline test
coverage under `lexicons/fly/src/op/activities/` (`sprite-tasks.test.ts`,
`sprite-config.test.ts`, `sprite-fs.test.ts`).
