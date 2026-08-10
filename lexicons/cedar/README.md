# @intentius/chant-lexicon-cedar

Cedar lexicon plugin for [chant](https://github.com/intentius/chant) — typed
authoring for [Cedar](https://www.cedarpolicy.com/) authorization policies.

Cedar has no variables, no modules and no loops, and its toolchain validates
and evaluates policies after they are written. Teams generate `.cedar` text
with string templating today. This lexicon is the typed authoring layer above
that text.

## Status

The lexicon lands across the sub-issues of INTENTIUS/chant#1645. What works
today is the scaffold and serializer (#1649) and schema-driven codegen
(#1650). Lint and post-synth validation through `cedar-wasm` (#1651), AVP
embedding (#1652), import (#1653), and the docs/LSP/skills surface (#1654)
follow.

## The policy model

A policy is a `Cedar::Policy` entity whose props are:

| Prop | Meaning |
|------|---------|
| `effect` | `"permit"` or `"forbid"`; defaults to `permit` |
| `principal`, `action`, `resource` | scope constraints — `{}` for any, or `{ eq }`, `{ in }`, `{ is }` |
| `when`, `unless` | Cedar expression strings, one clause each |
| `annotations` | `Record<string, string>`, emitted as `@key("value")` |

The policy id comes from the export's logical name (`allowAdminRead` →
`allow-admin-read`) unless `annotations.id` sets one.

## Where the types come from

`chant generate` reads a `.cedarschema` and emits a class per entity type, a
constant per action, and a UID type per entity — so `action: { eq: ReadAction }`
is checked at compile time and a renamed entity type is a compiler-guided
refactor.

Point it at your schema in `chant.config.ts`:

```ts
import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-cedar";

export default {
  lexicons: ["cedar"],
  cedar: { schema: "schema.cedarschema" },
} satisfies ChantConfig;
```

`cedar.schema` defaults to `schema.cedarschema` in the project root. When
neither the configured path nor that default exists, generation falls back to
the small application-authorization schema bundled at
`src/spec/default-schema.cedarschema`, so a fresh checkout still produces a
surface. Set `cedar.validation.requireProjectSchema` to turn that fallback off
once your project has its own schema.

## Pins

Two, for two different things:

- `CEDAR_WASM_VERSION` — the `@cedar-policy/cedar-wasm` package, bumped by the
  weekly `cedar-upgrade` Op.
- `CEDAR_LANG_VERSION` — the Cedar *language* that package implements (4.5).
  `generate()` asserts it before emitting anything, because a package bump that
  leaves the language alone cannot change what parses.

Beside them, a content pin over the resolved JSON of the bundled default
schema. It moves when the schema is edited and — the case it exists for — when
a cedar-wasm upgrade resolves the same schema differently. Both rewrite the
generated types, and `src/generated/` is not committed.

## Output

Serializing produces canonical `.cedar` policy text as the primary output and
a Cedar JSON policy set as `policies.cedar.json` beside it. Both are consumed
by any Cedar evaluator with chant nowhere in sight.

## Commands

```bash
just bundle     # build dist/ (manifest, rules, integrity, OKF)
just test       # run the lexicon's tests
just validate   # check generated artifacts
just generate   # schema-driven codegen from your .cedarschema
```

## Project structure

- `src/plugin.ts` — LexiconPlugin with all lifecycle methods
- `src/serializer.ts` — `.cedar` text and JSON policy-set output
- `src/codegen/` — code generation and packaging pipelines
- `src/spec/` — upstream schema fetching and parsing
- `src/lint/rules/` — lint rules
- `src/lsp/` — LSP completions and hover
- `src/generated/` — generated artifacts (do not edit)
