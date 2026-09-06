---
skill: chant-fountain
description: Declare, lint, and reconcile fountain Environments, Vaults, and Agents from a chant project
user-invocable: true
---

# Fountain Workloads as Typed Estate

## What this lexicon covers

[fountain](https://github.com/BinaryBourbon/fountain) runs coding agents in sandboxed VMs. Six kinds are declarable, and this lexicon types all of them. `Environment` (sandbox baseline), `Vault` (env-var overrides) and `Agent` (a runnable agent config) are the workload layer; `Teammate` (an agent seated on the team, with a thread of its own), `Schedule` (a cron prompt into that thread) and `Webhook` (where the estate's events leave it) are the team, schedule and webhook routes. Conversations are runs, not resources: start them with the `fountainRun` op, never declare them.

The source of truth is the TypeScript in `src/`. `chant build` serializes it to fountain's own manifest YAML (ejectable — `fountain apply -f` accepts it verbatim). `fountainApply` sends that same YAML to fountain's bulk `POST /api/apply` endpoint in one request: create-if-new, update-by-name, opt-in owned-only prune keyed on the `managed-by: chant` metadata marker. Bulk apply covers Environment, Vault and Agent only — a Teammate, Schedule or Webhook document is emitted and valid, and applying it through its own route waits on chant #2127.

## Authoring

```ts
import { Environment, Agent } from "@intentius/chant-lexicon-fountain";

export const env = new Environment({
  name: "team-env",
  networking_type: "limited",                     // FTN010 requires explicit intent
  networking_config: { allowed_hosts: ["github.com"] },
  metadata: { "managed-by": "chant" },            // enables owned-only reconcile/prune
});

export const helper = new Agent({
  name: "helper",
  model: "anthropic/claude-sonnet-4-6",
  runtime: "claude",
  environment: env,                               // typed ref — dangling name = build error
  skills: [{ source: "owner/skills-repo", ref: "v1.0.0" }],  // always pin a ref
});
```

## Endpoint and auth

`FOUNTAIN_ENDPOINT` (defaults to the hosted instance) + `FOUNTAIN_TOKEN` (mint via `POST /api/auth/token` with email+password, or the account UI). The same code applies to a local `mix phx.server` fountain by pointing `FOUNTAIN_ENDPOINT` at it — registration and token mint work headless, so CI needs no browser.

## The loop

1. `chant build` — synthesize + lint (FTN rules catch open networking, credential literals, unresolvable `${VAR}` refs before review).
2. `chant run <apply op>` or call `fountainApply` — reconcile. Idempotent by name.
3. `chant lifecycle diff --live` — drift: a UI edit to an owned Environment shows up here.
4. `chant import --from` — adopt UI-built resources into typed files (secrets stay behind; see the secrets skill).

## `chant acp` — a prompt is a chant command line

A fountain `Agent` with `runtime: "acp"` and `runtime_command: "chant acp"` runs chant itself as the coding agent. chant then speaks the [Agent Client Protocol](https://agentclientprotocol.com) over stdio, and every `session/prompt` is one chant command line:

```
chant run prod-apply --env prod
chant lifecycle diff --live
```

That is the whole convention, and it is what makes the teammate's thread readable: each turn is a command someone could have typed, so scrolling the thread is scrolling the environment's shell history.

It is a command *line*, not a shell line. The text is split with quote awareness and nothing else — no `$VAR`, no `&&`, no pipes, no globbing — and the verb is resolved against chant's own command registry. `rm -rf /` is refused before anything runs, with the reason in the reply.

What a client sees:

- `chant run <op>` emits one `tool_call` per declared step (`<phase> / <fn>`, `kind: "execute"`, the step args as `rawInput`) before the run starts, then a `tool_call_update` as each step settles. Stdout and stderr stream as `agent_message_chunk`s and the run ledger record is the final chunk.
- Any other verb runs with `--json` and streams its output the same way.
- A run that stops at an unapproved gate replies with the pending fact and the `chant approve <op> <gate>` line, and the turn ends. The gate is a fact on chant's ledger, not a wait — the next run re-evaluates it.
- `session/cancel` aborts the in-flight step, runs the op's `onFailure` phases, and ends the turn `cancelled`.

`--durable-requests` turns the gated reply into a `session/request_permission` with `allow_once`/`reject_once` and ends the turn `waiting`; the client answers on a later prompt carrying `_meta.chant.permission`, which records the resolution and re-runs. It is off by default because a request that outlives a turn needs BinaryBourbon/fountain#1635.

The server does not redact. A step's output reaches the thread verbatim and fountain redacts secrets on the way in; chant never reads or prints the environment it was spawned with.
