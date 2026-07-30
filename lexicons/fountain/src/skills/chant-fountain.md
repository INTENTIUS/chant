---
skill: chant-fountain
description: Declare, lint, and reconcile fountain Environments, Vaults, and Agents from a chant project
user-invocable: true
---

# Fountain Workloads as Typed Estate

## What this lexicon covers

[fountain](https://github.com/BinaryBourbon/fountain) runs coding agents in sandboxed VMs. Its workload layer is three kinds — `Environment` (sandbox baseline), `Vault` (env-var overrides), `Agent` (a runnable agent config) — and this lexicon declares them as typed chant resources. Conversations are runs, not resources: start them with the `fountainRun` op, never declare them.

The source of truth is the TypeScript in `src/`. `chant build` serializes it to fountain's own manifest YAML (ejectable — `fountain apply -f` accepts it verbatim) plus a `fountain-plan.json` sidecar that `fountainApply` reconciles against the API directly: create-if-new, update-by-name, opt-in owned-only prune keyed on the `managed-by: chant` metadata marker.

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
