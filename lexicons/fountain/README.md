# @intentius/chant-lexicon-fountain

fountain lexicon plugin for [chant](https://github.com/intentius/chant).

[fountain](https://github.com/BinaryBourbon/fountain) runs coding agents in
sandboxed VMs. This lexicon declares its workload layer as typed chant
resources: `Environment` (sandbox baseline), `Vault` (env-var overrides),
`Agent` (a runnable agent config). Conversations are runs, not resources —
start them with the `fountainRun` op.

`chant build` serializes to fountain's own manifest YAML (`fountain apply -f`
accepts it verbatim) plus a `fountain-plan.json` sidecar that `fountainApply`
reconciles against the API directly.

```ts
import { Environment, Agent } from "@intentius/chant-lexicon-fountain";

export const env = new Environment({
  name: "team-env",
  networking_type: "limited",                    // FTN010 requires explicit intent
  networking_config: { allowed_hosts: ["github.com"] },
  metadata: { "managed-by": "chant" },           // enables owned-only reconcile/prune
});

export const helper = new Agent({
  name: "helper",
  model: "anthropic/claude-sonnet-4-6",
  runtime: "claude",
  environment: env,                              // typed ref — dangling name = build error
});
```

For agents handling anything sensitive, `ConciergeStack` bundles the
locked-down defaults (deny-all egress, no vault overrides, ownership marker
on both resources) so loosening any of them is a visible, reviewable
parameter.

## Development

```bash
just generate    # regenerate types from the upstream OpenAPI spec
just validate    # check the generated artifacts
just docs        # build and serve the docs site
```

The spec is a rolling endpoint with no release tag to pin, so generation
falls back to a committed snapshot (`src/spec/fountain-openapi.snapshot.json`)
when the live endpoint is unreachable. `chant dev coverage` compares the
generated surface against that spec and reports properties upstream has
added, plus the request schemas deliberately left unmodeled.

## Project structure

- `src/plugin.ts` — LexiconPlugin with all lifecycle methods
- `src/serializer.ts` — manifest YAML + `fountain-plan.json` output
- `src/codegen/`, `src/spec/` — generation pipeline and spec fetch/parse
- `src/lint/rules/`, `src/lint/post-synth/` — FTN001 (AST) and FTN010–017
- `src/op/activities/` — `fountainApply` (reconciler) and `fountainRun`
- `src/composites/` — `ConciergeStack`
- `src/skills/` — agent skills for authoring, secrets, and locked sandboxes
- `src/import/`, `src/describe-resources.ts` — adoption and live observation
- `src/lsp/` — completions and hover
- `src/generated/` — generated artifacts (do not edit)
