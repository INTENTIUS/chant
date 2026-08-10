# @intentius/chant-lexicon-cedar

Cedar lexicon plugin for [chant](https://github.com/intentius/chant) — typed
authoring for [Cedar](https://www.cedarpolicy.com/) authorization policies.

Cedar has no variables, no modules and no loops, and its toolchain validates
and evaluates policies after they are written. Teams generate `.cedar` text
with string templating today. This lexicon is the typed authoring layer above
that text.

## Status

The lexicon lands across the sub-issues of INTENTIUS/chant#1645. What works
today is the scaffold, the serializer and packaging (#1649). Schema-driven
codegen (#1650), lint and post-synth validation through `cedar-wasm` (#1651),
AVP embedding (#1652), import (#1653), and the docs/LSP/skills surface (#1654)
follow.

## The policy model

Until codegen lands, a policy is a `Cedar::Policy` entity whose props are:

| Prop | Meaning |
|------|---------|
| `effect` | `"permit"` or `"forbid"`; defaults to `permit` |
| `principal`, `action`, `resource` | scope constraints — `{}` for any, or `{ eq }`, `{ in }`, `{ is }` |
| `when`, `unless` | Cedar expression strings, one clause each |
| `annotations` | `Record<string, string>`, emitted as `@key("value")` |

The policy id comes from the export's logical name (`allowAdminRead` →
`allow-admin-read`) unless `annotations.id` sets one.

Codegen generates typed entity and action classes onto this same shape, so the
serializer does not change when it arrives.

## Output

Serializing produces canonical `.cedar` policy text as the primary output and
a Cedar JSON policy set as `policies.cedar.json` beside it. Both are consumed
by any Cedar evaluator with chant nowhere in sight.

## Commands

```bash
just bundle     # build dist/ (manifest, rules, integrity, OKF)
just test       # run the lexicon's tests
just validate   # check generated artifacts (needs #1650)
just generate   # schema-driven codegen (needs #1650)
```

## Project structure

- `src/plugin.ts` — LexiconPlugin with all lifecycle methods
- `src/serializer.ts` — `.cedar` text and JSON policy-set output
- `src/codegen/` — code generation and packaging pipelines
- `src/spec/` — upstream schema fetching and parsing
- `src/lint/rules/` — lint rules
- `src/lsp/` — LSP completions and hover
- `src/generated/` — generated artifacts (do not edit)
