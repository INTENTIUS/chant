---
skill: chant-fountain-locked-sandboxes
description: Declare locked-down fountain environments for untrusted or security-sensitive agents, and run conversations against them
user-invocable: true
---

# Locked-Down Sandboxes and Conversation Runs

## The posture

For an agent handling anything sensitive (a repo checkout, an internal API), declare the environment closed by construction:

```ts
export const lockedEnv = new Environment({
  name: "concierge-env",
  networking_type: "limited",
  networking_config: { allowed_hosts: ["registry.npmjs.org", "github.com"] },
  metadata: { "managed-by": "chant" },
});
```

Semantics (from fountain's own schema): `unrestricted` is a no-op — sprites are open by default. `limited` restricts egress to `allowed_hosts`; with **no** hosts (or an empty list) it denies all egress — deny-all, not allow-all. So `limited` + `[]` is the isolation mode.

Pair it with a closed vault policy on the agent — `allowed_vault_ids: []` — so no conversation can override the reviewed environment at spawn, and give the sandbox **no cloud credentials of any kind**: anything readable inside is exfiltratable by prompt injection. Services the agent needs live outside the sandbox behind their own auth; the sandbox gets at most a conversation-scoped token.

Lint posture: FTN010/FTN011 fire on missing/unrestricted networking at warning severity by default. For repos whose environments are all concierge-class, promote them to error via project rules.

## Drift is the alarm

The environment's config is the enforcement boundary, so watch it: `chant lifecycle diff --live` flags a UI edit that adds a secret, opens networking, or drops the marker. Wire it into a scheduled watch — an out-of-band change to a locked environment is an incident, not housekeeping.

## Running conversations

Conversations are runs, not resources. Use the `fountainRun` activity: resolves the agent by name, starts (optionally with a prompt and an allowlisted vault), and waits for the turn to end. What "end" means, and what happens to the machine, follows the agent's `sandbox_mode`: an `ephemeral` agent's conversation is polled for a terminal status and terminated on deadline, same as before; a `persistent` agent's (a `Steward` or `Box`) conversation settles on `idle` once its turn ends — machine still up for the next turn — so `fountainRun` reads the turn back and returns its outcome (`completed | failed | interrupted`) without terminating anything, by default. Pass `terminate: "on-deadline" | "always"` to opt a persistent agent's run back into ending the machine. Multi-turn interaction (follow-up prompts, interrupt) is fountain's own conversations API — keep chant to the lifecycle edges.
