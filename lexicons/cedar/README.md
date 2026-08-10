# @intentius/chant-lexicon-cedar

Cedar lexicon plugin for [chant](https://github.com/intentius/chant) — typed
authoring for [Cedar](https://www.cedarpolicy.com/) authorization policies.

Cedar has no variables, no modules and no loops, and its toolchain validates
and evaluates policies after they are written. Teams generate `.cedar` text
with string templating today. This lexicon is the typed authoring layer above
that text.

## Status

Complete. The lexicon landed across the eight sub-issues of
INTENTIUS/chant#1645: the upstream pin (#1648), the scaffold and serializer
(#1649), schema-driven codegen (#1650), lint and post-synth validation through
`cedar-wasm` (#1651), AVP embedding and policy-store observation (#1652),
import/reconcile (#1653), the docs/LSP/MCP/skills/composites surface (#1654),
and CI/publishing onboarding (#1655).

Landing beside it, and pre-release on its own terms, is the dogwood temporal
dialect (epic #1646) — see [The dogwood dialect](#the-dogwood-dialect-pre-release).
It is a surface *inside* this lexicon rather than a sibling, so the eight
sub-issues above are still the whole of Cedar itself.

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

## Amazon Verified Permissions

AVP is one evaluator among several, and the aws lexicon keeps the deployment
vehicle. What this lexicon adds is the typed statement inside it:
`avpPolicyDefinition(name, props)` returns exactly the `Definition` property
`AWS::VerifiedPermissions::Policy` takes, rendered by the same renderer that
writes the `.cedar` file — so the two cannot drift. There is deliberately **no
dependency on the aws lexicon**; the seam is the data shape. See
`examples/avp-embedding/`.

Beside the embedding, `describeResources()`, `observeAmbient()` and
`exportResources()` read a live policy store. `chant lifecycle diff --live`
reports declared policies that are missing from the store, and
`observeAmbient()` reports the reverse — policies in the store that no
declaration accounts for, which for an authorization store is a standing grant
nobody in the source tree can see.

The store is named by `CEDAR_AVP_POLICY_STORE_ID` (or
`CEDAR_AVP_POLICY_STORE_ID_<ENV>`), or by a `policyStoreId` prop on a declared
policy. AVP policy stores are taggable and individual policies are not, so
chant's per-policy ownership marker rides in the policy description — the
design record is `src/avp/OWNERSHIP.md`.

## The dogwood dialect (pre-release)

[Dogwood](https://github.com/dogwood-policy/dogwood) is Cedar with temporal
operators: a policy can depend on what already happened in a session, so
approval-before-action, rate limits and budgets become policy rather than
application code. It ships here as a dialect rather than as a sibling lexicon —
a `.dw` file stripped of Cedar semantics is meaningless, and the head of a
`.dw` policy is Cedar's, byte for byte. Its checks are under the `DWD` id
family, declared on the serializer's `extraRulePrefixes`.

```ts
import { TemporalPolicy, TemporalEventSchema, dogwood } from "@intentius/chant-lexicon-cedar";

export const events = new TemporalEventSchema({ schema: dogwood.defaultEventSchema() });

export const readAfterLogin = new TemporalPolicy({
  action: { eq: 'Drupe::Action::"Read"' },
  whenTemporal: [
    dogwood.formerly("1h", dogwood.predicate('Drupe::Action::"Login"', "response", {
      "input.user": dogwood.ctx("input.user"),
    })),
  ],
});
```

A build holding temporal policies emits `policies.dw` beside the `.cedar`
outputs, plus `events.dwschema` and `macros.dw` where those are declared.

The builders target dogwood's **parser primitives** — `formerly`, `previous`,
`since`, `exists`, `tp()`, `count for … where`, `sum … for … where` — because
those are the only temporal keywords in the grammar. `count_within`,
`sum_within` and `count_distinct_within` are macros in a default library that
a caller passing `--macros` replaces wholesale, so they are expressible as
calls (`dogwood.countWithin`) and never as operators. `dogwood.defaultMacroLibrary()`
emits the same definitions into a project's own file for anyone who would
rather not depend on the far end's.

Three walls run in the build with no dogwood binary anywhere: a temporal
predicate naming an event kind the emitted `.dwschema` never declares
(DWDC010), a window past the schema's `max_window` or upstream's 24h default
(DWDC011), and a `formerly`/`previous`/`since` with no window (DWDC012, which
the typed builders already make unrepresentable). DWDS010 reports an event
schema that pins nothing — supplying any schema opts out of upstream's
`callerPrincipal` pin, which widens every temporal predicate to cross-principal.

Pre-release. Upstream is a read-only squash-sync mirror of an internal Amazon
repository with no tags, no releases and no stability statement, and its README
says it is not intended for production use. The revision this is built against
is recorded in `src/dogwood/upstream.ts`; full `.dw` validation shells to the
`dogwood` binary and is deliberately not part of any gating check.

## Bedrock AgentCore

`AWS::BedrockAgentCore::Policy` is where a temporal policy is actually
deployed, and its `Definition` is a two-arm `oneOf`: `Cedar.Statement` for plain
Cedar, `Policy.Statement` for anything else. That second arm is what a `.dw`
policy travels in.

`agentCorePolicyDefinition(name, policy)` picks the arm from the policy — a
`TemporalPolicy`, or any props carrying a temporal clause, goes to `Policy`;
plain Cedar goes to `Cedar`. Same no-dependency rule as the AVP seam above: the
seam is the data shape, not an import. Templates are refused, because
AgentCore's union has no template-linked arm.

`EnforcementMode` is the staging dial. `LOG_ONLY` is evaluated on every request
and its decision is observed rather than returned, which is observe-before-
enforce in the substrate, per policy — and it is how a temporal rule should
start, since whether `formerly within 1h …` fires depends on traffic nobody has
replayed:

```ts
new BedrockAgentCorePolicy({
  PolicyEngineId: engine.ref(),
  ...agentCoreStagedPolicy("writeNeedsApproval", writeNeedsApproval, "log-only"),
});
```

Promotion is `"log-only"` → `"enforce"`. The resource carries a statement and
nothing else, so the event schema has no property to live in and is registered
with the engine separately; DWDC013 warns when a build embeds temporal text and
emits no `.dwschema` beside it, because the deployed statement then matches
nothing and fails open or closed without failing. See
`examples/agentcore-policy/`.

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
- `src/policy-text.ts` — policy-head rendering shared by every renderer
- `src/avp/` — AVP embedding, the policy-store readers, and the ownership channel
- `src/agentcore/` — the AgentCore `Definition` seam and the `EnforcementMode` dial
- `src/dogwood/` — the temporal dialect: builders, `.dw`/`.dwschema` output
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
