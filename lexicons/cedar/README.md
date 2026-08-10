# @intentius/chant-lexicon-cedar

Cedar lexicon plugin for [chant](https://github.com/intentius/chant) — typed
authoring for [Cedar](https://www.cedarpolicy.com/) authorization policies.

Cedar has no variables, no modules and no loops, and its toolchain validates
and evaluates policies after they are written. Teams generate `.cedar` text
with string templating today. This lexicon is the typed authoring layer above
that text.

## Status

The lexicon lands across the sub-issues of INTENTIUS/chant#1645. What works
today is the scaffold and serializer (#1649), schema-driven codegen (#1650),
lint and post-synth validation through `cedar-wasm` (#1651), import/reconcile
(#1653), and the docs/LSP/MCP/skills/composites surface (#1654). AVP embedding
and policy-store observation (#1652) follow.

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

The JSON leg is built by handing the emitted text back to `cedar-wasm`, so
what lands on disk is Cedar's own reading of it — expression trees, not
expression source — and a policy carrying a `?principal`/`?resource` slot is
filed under `templates` rather than `staticPolicies` because Cedar, not this
serializer, decides which it is. Text the module cannot parse yields a build
warning and no JSON file, never an invalid one.

## Import

`chant import` reads either surface back into TypeScript:

```bash
chant import policies.cedar.json --output ./src
```

The text leg round-trips byte-for-byte — `.cedar` → props → `new Policy({ … })`
→ `.cedar` — because condition bodies are lifted out of the source verbatim and
then checked against the tree `cedar-wasm` makes of them. Two normalizations do
happen on the first lap and settle after it: annotations come back
alphabetically (they serialize into a sorted map), and interleaved
`when`/`unless` clauses regroup, since they are separate props.

Importing the JSON envelope instead has no source to quote, so its clauses come
back as the module renders them — semantically identical, defensively
parenthesized.

## Composites

Cedar has nowhere to put a repeated policy shape, so the factories live here.

```ts
import { OwnerCanManage, DenyByDefaultSet } from "@intentius/chant-lexicon-cedar";
```

- `OwnerCanManage({ entityType, actions })` — a permit whose resource scope and
  ownership guard arrive together.
- `DenyByDefaultSet({ policies, when })` — a guarded `forbid` floor and the
  permits it governs, returned from one call so the floor cannot be dropped
  alone. It throws on an empty `when`: an unguarded forbid overrides every
  permit and authorizes nothing.

## Agent surface

Three skills (`chant-cedar-authoring`, `chant-cedar-avp-embedding`, `chant-cedar-meta-policy`),
three `chant init` templates (`default`, `avp-embedding`,
`gateway-policy-set`), and three MCP contributions:

| Contribution | What it answers |
|---|---|
| `cedar:diff` | This build's policy set against the previous one |
| `chant://cedar/resource-catalog` | Every declaration generated from the schema |
| `cedar:coverage` | Which schema entity types and actions the policy set can apply to, which are reachable only from a `forbid`, and which no policy touches |

`cedar:coverage` resolves each policy through Cedar's own
`getValidRequestEnvsPolicy` rather than reading the scope literally, so action
groups, `is`, `in` and `appliesTo` are expanded by Cedar and not by a second,
worse implementation of it.

## Commands

```bash
just bundle     # build dist/ (manifest, rules, integrity, OKF)
just test       # run the lexicon's tests
just validate   # check generated artifacts
just generate   # schema-driven codegen from your .cedarschema

npm run docs        # regenerate the docs site's pages + sidebar
npm run docs:build  # build the Starlight site in docs/
```

## Project structure

- `src/plugin.ts` — LexiconPlugin with all lifecycle methods
- `src/serializer.ts` — `.cedar` text and JSON policy-set output
- `src/import/` — `chant import` parser, generator and round-trip fixtures
- `src/detect.ts` — which documents belong to this lexicon
- `src/codegen/` — code generation, docs, and packaging pipelines
- `src/spec/` — schema resolution, parsing, and the grammar pin
- `src/lint/rules/` — lint rules
- `src/lsp/` — LSP completions and hover over the generated registry
- `src/mcp/` — MCP tools and resources, including policy coverage
- `src/composites/` — `OwnerCanManage`, `DenyByDefaultSet`
- `src/skills/` — the three agent skills
- `src/init-templates.ts` — `chant init --lexicon cedar --template …`
- `src/generated/` — generated artifacts (do not edit)
- `docs/` — the standalone Starlight site, generated by `npm run docs`
