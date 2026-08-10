/**
 * The cedar lexicon's Starlight site.
 *
 * Pages are declared as `extraPages` rather than left as hand-written files in
 * docs/. The pipeline rebuilds the sidebar from the pages it knows about on
 * every run, and Starlight does not auto-discover, so a page the config has
 * never heard of exists on disk and is reachable only by typing its URL
 * (chant #1312).
 *
 * Two more pages come out of the pipeline itself: the generated rules table
 * (`rules`) and the serialization reference. Both are linked from the sidebar
 * automatically.
 *
 * Cross-namespace links are written as full `/chant/...` paths. This site's
 * base is `/chant/lexicons/cedar/`, so a bare `/guide/...` would be rewritten
 * to `/chant/lexicons/cedar/guide/...`; the rehype plugin's idempotency check
 * leaves an already-project-rooted path alone. Sibling pages use `../slug/`,
 * because `./slug` from an MDX body resolves as a child.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";
import {
  dogwoodEventSchemas,
  dogwoodOverview,
  dogwoodReplay,
  dogwoodTemporalPolicies,
  dogwoodValidation,
} from "./docs-dogwood";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// ── index ─────────────────────────────────────────────────────────

const overview = `The **cedar** lexicon is the typed authoring layer above [Cedar](https://www.cedarpolicy.com/), the vendor-neutral authorization policy language that joined the CNCF as a Sandbox project in December 2025.

Cedar is deliberately abstraction-free: no variables, no modules, no loops, and templates carrying exactly two slots (\`?principal\`, \`?resource\`). Its own toolchain validates and evaluates — it checks policies after they are written and decides requests at runtime. Everything upstream of the policy text is unowned, which is where this lexicon lives.

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-cedar
\`\`\`

## Quick start

\`\`\`typescript
import { Policy, ReadAction } from "@intentius/chant-lexicon-cedar";

export const ownerRead = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { eq: ReadAction },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal"],
});
\`\`\`

\`ReadAction\` and \`"App::User"\` are generated from *your* Cedar schema, so a
renamed entity type is a compiler-guided refactor and a typo'd action is a
compile error — not a validation failure after the text is written.

## What comes out

| File | Who reads it |
|------|--------------|
| \`<name>.cedar\` | Every Cedar evaluator — Amazon Verified Permissions, cedar-agent, an embedded \`cedar-wasm\` |
| \`policies.cedar.json\` | The Cedar JSON policy format; also the parse source for import |

chant appears in neither. An emitted policy set walks away and is consumed by
any evaluator with chant nowhere in sight.

## Cedar is a target, never a gate

There is no \`cedarGate()\` and there will not be one.
[Organizational policy](/chant/guide/organizational-policy/) in chant is
TypeScript post-synth checks; a second policy engine would duplicate the lint
engine. chant compiles *to* Cedar; it is not governed *by* Cedar.

## The dogwood dialect

Cedar with temporal operators, shipping inside this lexicon as a pre-release
surface under the \`DWD\` id family: a policy that can depend on what already
happened in a session. Start at [The Dogwood Dialect](./dogwood), which is
honest about upstream's governance before it shows you a builder.`;

// ── getting-started ───────────────────────────────────────────────

const gettingStarted = `Three steps, in this order. The second one is the one people skip.

## 1. Scaffold

\`\`\`bash
npx chant init --lexicon cedar --template default my-authz
cd my-authz && npm install
\`\`\`

Three templates ship: \`default\` (a permit/forbid pair), \`avp-embedding\` (a
multi-tenant store bound for Verified Permissions), and \`gateway-policy-set\`
(API routes as entities, behind a deny floor). Each writes a
\`schema.cedarschema\` at the project root and a \`src/policies.ts\` typed
against it.

## 2. Generate

\`\`\`bash
npx chant generate --lexicon cedar
\`\`\`

This is not optional and it is not a one-time setup step. The classes and
action constants \`policies.ts\` imports **do not exist** until generate has read
your schema. Re-run it whenever the schema changes.

What it produces, per declaration:

| Schema | Generated |
|---|---|
| \`entity Document in [Folder] = { … }\` | \`Document\`, \`DocumentAttributes\`, \`DocumentUid\` |
| \`action read appliesTo { … }\` | \`ReadAction\`, \`ReadContext\` |
| — | \`Policy\`, \`EntityTypeName\`, \`ActionUid\`, \`PolicyScope\`, \`ALL_ACTIONS\`, \`ALL_ENTITY_TYPES\` |

## 3. Build

\`\`\`bash
npx chant build
\`\`\`

Both artifacts land in \`dist/\`. Every emitted policy set is validated against
your schema by \`cedar-wasm\` — the real Cedar validator, running in-process.
No CLI on PATH, no Docker.

## Then

\`\`\`bash
npx chant coverage --lexicon cedar   # is every schema declaration generated?
\`\`\`

The MCP tool \`cedar:coverage\` answers the harder question — which schema
declarations the *policy set* actually reaches. See [Lint Rules](../lint-rules/).

## The example projects

Two ship with the lexicon:

- \`examples/getting-started\` — one permit, one forbid, against the bundled default schema.
- \`examples/basic-policies\` — a project-local \`schema.cedarschema\` and a four-policy set.

Both are exercised in CI: the emitted \`.cedar\` text is handed straight to
\`cedar-wasm\`, so a policy set chant is happy with but Cedar rejects fails the
build rather than the deploy.
`;

// ── schema ────────────────────────────────────────────────────────

const schemaPage = `Unlike every other lexicon, cedar's interesting spec is not one global upstream. It is **your** schema.

The pinned upstream here is the Cedar *grammar* — \`@cedar-policy/cedar-wasm\`,
whose language version is asserted before anything is emitted. The schema is
the input.

## Where it is looked for

1. \`cedar.schema\` in \`chant.config.ts\`
2. \`schema.cedarschema\` in the project root
3. the schema bundled with the lexicon

Step 3 exists so \`generate()\` has something to read in a fresh clone — a
generate step that only works after the user does something is a generate step
nothing gates. It is a real application-authorization model, not a stub.

**Turn it off once you have your own:**

\`\`\`typescript
// chant.config.ts
import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-cedar";

export default {
  lexicons: ["cedar"],
  cedar: {
    schema: "authz/app.cedarschema",
    validation: {
      mode: "strict",
      warnings: "warn",
      requireProjectSchema: true,
    },
  },
} satisfies ChantConfig;
\`\`\`

Without \`requireProjectSchema\`, a typo in the path is the difference between
"your entity types" and "the bundled default" — and the build succeeds either
way.

## Writing one

\`\`\`
namespace App {
  type Level = Long;
  type TagSet = Set<String>;

  entity Group = { "name": String };

  entity User in [Group] = {
    "email": String,
    "level": Level,
    "manager"?: User,
    "roles": TagSet,
  };

  entity Document = {
    "title": String,
    "owner": User,
    "classification": String,
  };

  action read, write appliesTo {
    principal: [User],
    resource: [Document],
    context: { "mfa": Bool }
  };
}
\`\`\`

Common types (\`type Level = Long\`) are resolved away by the codegen — real
schemas use them, so the resolver collapses them rather than pretending they
are absent.

## Config keys

| Key | Meaning |
|-----|---------|
| \`schema\` | Path to the \`.cedarschema\`, relative to the project root |
| \`validation.mode\` | \`"strict"\`. The only mode cedar-wasm 4.12 accepts |
| \`validation.warnings\` | \`"ignore"\`, \`"warn"\`, or \`"error"\` — the validator reports "policy is impossible" here, separately from errors |
| \`validation.requireProjectSchema\` | Refuse to fall back to the bundled default |

The namespace is a \`strictObject\`, nested levels included: a typo inside
\`validation\` is a config error, not a silently ignored key.

## Both syntaxes

Cedar's schema grammar has a human-readable form and a JSON form. The codegen
consumes the human-readable one; \`cedar-wasm\` converts between them
(\`schemaToJson\`, \`schemaToText\`) if you need the other.

## The pin

The language version is pinned separately from the package version. A package
bump that leaves the language at 4.x cannot change what parses, so
\`CEDAR_WASM_VERSION\` is what the self-upgrade tooling moves and
\`CEDAR_LANG_VERSION\` is what \`generate()\` asserts at runtime. Both live in
\`src/spec/pin.ts\`, beside a content pin over the bundled default schema.
`;

// ── resources ─────────────────────────────────────────────────────

const resourcesPage = `Everything below \`Policy\` is generated from your schema, so the exact list depends on it. What follows is the shape.

## Policy

The one declaration this lexicon serializes. One \`Policy\` per policy.

\`\`\`typescript
import { Policy } from "@intentius/chant-lexicon-cedar";

export const ownerRead = new Policy({ /* … */ });
\`\`\`

Its props are covered in [Policies](../policies/).

## Entity classes

Each \`entity T = { … }\` in the schema produces three things:

| Generated | Kind | What it is |
|---|---|---|
| \`Document\` | resource class | The entity type, for declaring entities |
| \`DocumentAttributes\` | property class | Its attribute record, usable standalone |
| \`DocumentUid\` | type | \`` + "`" + `App::Document::"\${string}"` + "`" + `\` — a template-literal type |

\`DocumentUid\` is the one that earns its keep. It makes a mistyped namespace a
compile error:

\`\`\`typescript
import type { DocumentUid } from "@intentius/chant-lexicon-cedar";

const contract: DocumentUid = 'App::Document::"contract-2026"';  // ok
const typo: DocumentUid = 'App::Docmnt::"contract-2026"';        // compile error
\`\`\`

## Action constants

Each action produces a \`const\` (not a class — an action UID is a value, not a
constructor) and a context record type:

\`\`\`typescript
import { ReadAction, type ReadContextProps } from "@intentius/chant-lexicon-cedar";

// ReadAction === 'App::Action::"read"'
\`\`\`

## Schema-wide types

| Name | What it holds |
|---|---|
| \`EntityTypeName\` | Union of every entity type name, as Cedar writes it |
| \`EntityUid\` | Union of every entity UID type |
| \`ActionUid\` | Union of every action UID |
| \`PolicyRef\` | \`EntityUid \\| ActionUid\` — anything a scope may name |
| \`PolicyScope\` | One scope position |
| \`ALL_ACTIONS\` | Every action constant, for exhaustive iteration |
| \`ALL_ENTITY_TYPES\` | Every entity type name |

\`ALL_ACTIONS\` is what a cross-domain post-synth check iterates when asking "is
any action uncovered".

## Naming

Names are derived from the schema and de-duplicated against a single pool, so a
schema declaring an entity type literally called \`UserAttributes\` beside a
\`User\` does not get its name stolen by the derived record type. Two
declarations in the same namespace reducing to the same short name are both
qualified rather than one silently overwriting the other.

## Coverage

\`\`\`bash
npx chant coverage --lexicon cedar --verbose
\`\`\`

Reports whether every entity type and every action in the schema is reachable
from the generated artifacts. A gap is a defect: an action with no generated
constant is one a policy can only name as a hand-typed string, which is the
failure mode this lexicon exists to remove.
`;

// ── policies ──────────────────────────────────────────────────────

const policiesPage = `A policy is a \`Policy\` value. The serializer turns each one into a \`.cedar\` block and an entry in the JSON policy set.

## Props

| Prop | Meaning |
|------|---------|
| \`effect\` | \`"permit"\` or \`"forbid"\`. Defaults to \`permit\` |
| \`principal\`, \`action\`, \`resource\` | Scope constraints. Omit for unconstrained |
| \`when\` | Cedar expression strings, one \`when { … }\` clause each |
| \`unless\` | Cedar expression strings, one \`unless { … }\` clause each |
| \`annotations\` | \`Record<string, string>\`, emitted as \`@key("value")\` |

## Scope forms

The scope type mirrors the grammar exactly:

| Written | Emitted |
|---|---|
| \`{}\` or omitted | \`principal\` |
| \`{ eq: X }\` | \`principal == X\` |
| \`{ in: X }\` | \`principal in X\` |
| \`{ in: [X, Y] }\` | \`principal in [X, Y]\` |
| \`{ is: "App::User" }\` | \`principal is App::User\` |
| \`{ is: "App::User", in: X }\` | \`principal is App::User in X\` |

\`is\` takes an \`EntityTypeName\`; \`eq\` and \`in\` take a \`PolicyRef\`. Both are
schema-derived unions, so an entity type the schema never declared does not
compile.

## Conditions

\`when\` and \`unless\` carry Cedar expression **text**:

\`\`\`typescript
export const ownerWrite = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { eq: WriteAction },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal", "context.mfa == true"],
  unless: ['resource.classification == "confidential"'],
});
\`\`\`

Each array element becomes its own clause. They stay strings on purpose:
Cedar's expression grammar *is* the policy language, and typing it in
TypeScript is [import and reconcile](../importing/)'s problem, not codegen's.

## Policy ids

The id comes from the export's logical name, kebab-cased — \`allowAdminRead\`
becomes \`@id("allow-admin-read")\`. Set \`annotations.id\` to pin one:

\`\`\`typescript
export const anything = new Policy({
  annotations: { id: "tenant-isolation", owner: "platform" },
  // …
});
\`\`\`

An explicit \`id\` wins. \`@id\` is emitted first, then your annotations in
declaration order.

## permit and forbid

Cedar is default-deny, so a \`permit\` is what grants anything at all. A
\`forbid\` is not the absence of a grant — it beats every \`permit\` in the set
unconditionally, which makes it the only construct that survives a wider grant
somebody adds next quarter.

Two consequences worth internalizing:

- **A forbid with no guard denies everything**, and no permit can lift it. The
  \`DenyByDefaultSet\` [composite](../composites/) throws rather than emit one.
- **"Nobody wrote a permit" and "a forbid says no" evaluate identically** and
  read completely differently in review. Give sensitive resources an explicit
  floor.

## The JSON companion

Every build writes \`policies.cedar.json\` beside the \`.cedar\` text — the same
policy set in Cedar's JSON policy format, produced from the same structured
model rather than by re-parsing the text.

One deliberate gap: condition bodies are expression *ASTs* in that format, and
the model carries expression text. They are written as \`{ "__expr": "<text>" }\`,
Cedar's own escape for source-given expressions, so the file stays
machine-readable instead of inventing a private key. Producing real trees means
parsing Cedar expression text, which lands with import.
`;

// ── composites ────────────────────────────────────────────────────

const compositesPage = `Cedar has no functions, no modules, and no loops, so every repeated policy shape is copy-paste in \`.cedar\` text. A TypeScript factory is the only place the abstraction can live.

These follow chant's general
[composite resources](/chant/guide/composite-resources/) pattern: a function
returning declared resources, discovered like any other export.

\`\`\`typescript
import { OwnerCanManage, DenyByDefaultSet } from "@intentius/chant-lexicon-cedar";
\`\`\`

## OwnerCanManage

"The owner of a thing may act on it" — the most-repeated shape in any policy
set, and where the two classic mistakes get made: the \`when\` guard names an
attribute the schema spells differently, or the grant is written wide and the
scoping clause is forgotten.

\`\`\`typescript
import { ReadAction, WriteAction } from "@intentius/chant-lexicon-cedar";

export const docOwner = OwnerCanManage({
  entityType: "App::Document",
  actions: [ReadAction, WriteAction],
  principal: "App::User",
});
\`\`\`

Emits:

\`\`\`cedar
@id("doc-owner")
@composite("OwnerCanManage")
@scopedTo("App::Document")
permit (
  principal is App::User,
  action in [App::Action::"read", App::Action::"write"],
  resource is App::Document
)
when { resource.owner == principal };
\`\`\`

| Option | Default | Notes |
|---|---|---|
| \`entityType\` | required | \`EntityTypeName\` — schema-checked |
| \`actions\` | unconstrained | One action emits \`==\`, several emit \`in [ … ]\` |
| \`ownerAttribute\` | \`"owner"\` | The attribute holding the owner |
| \`principal\` | unconstrained | A bare type string becomes \`is T\`; a full scope passes through |
| \`when\` | — | Appended after the ownership test |
| \`unless\` | — | Omitted entirely when not asked for |
| \`annotations\` | — | Merged over the generated ones; an explicit \`id\` wins |

Leaving \`actions\` off produces a wide grant, so it has to be asked for by
omitting the field rather than arriving by accident.

## DenyByDefaultSet

A guarded \`forbid\` and the permits it governs, returned from one call. The
pattern teams write by hand is a forbid at the top of a file and a pile of
permits under it with nothing tying the two together — delete the forbid and
the permits keep working, wider than anyone intended.

\`\`\`typescript
import { DeleteAction } from "@intentius/chant-lexicon-cedar";

const guarded = DenyByDefaultSet({
  policies: [docOwner],
  entityType: "App::Document",
  actions: DeleteAction,
  when: ['resource.classification == "confidential"'],
  unless: ['principal == App::User::"archivist"'],
});

export const confidentialFloor = guarded.floor;
export const documentOwnerGrant = guarded.members[0];
\`\`\`

| Returned | What it is |
|---|---|
| \`floor\` | The \`forbid\` policy |
| \`members\` | The permits, unchanged, in the order given |
| \`all\` | \`[floor, ...members]\` |

\`when\` is required. An unguarded forbid overrides every permit in the set, so
the result would authorize nothing — the composite throws rather than emit it.

## Where composites go in a build

They return \`Declarable\` values like any other resource, so exporting them
from a discovered file is all that is needed:

\`\`\`typescript
export const [floor, grant] = DenyByDefaultSet({ /* … */ }).all;
\`\`\`

The floor is emitted first. Cedar's evaluation is order-independent — a forbid
wins wherever it sits — but a file that reads floor-first matches how the set
is reasoned about.
`;

// ── lint-rules ────────────────────────────────────────────────────

const lintRulesPage = `Rules under the \`CED\` prefix. The complete generated table is on [All Rules](../rules/); this page is the reasoning.

## The two engines, and why there is only one

Cedar's own validator runs in-process through \`@cedar-policy/cedar-wasm\` — the
real thing, not a reimplementation. It answers "is this policy well-formed
against this schema".

Everything else is a TypeScript check. There is no \`cedarGate()\`, because
organizational policy in chant is post-synth checks and a second policy engine
would duplicate the lint engine.

## The bare-permit wall

\`\`\`cedar
permit (principal, action, resource);
\`\`\`

Every scope unconstrained, no conditions. Legal Cedar, validates clean, grants
everything to everyone. The rule is **env-aware**:

| Environment | Verdict |
|---|---|
| dev / local | warn |
| staging | warn |
| prod | **fail** |

Env-aware rather than absolute because an absolute rule gets suppressed the
first time it fires during development, and a suppressed rule protects nothing.
A permit with any constrained scope position, or any \`when\`/\`unless\`, is not
bare.

## Schema-absent references

A policy naming an entity type or action the schema does not declare fails
**everywhere**, dev included. Two failure modes hide behind it:

- **The typo** — \`App::Documnt\`. Generated classes make this a compile error
  before any check runs; it survives only inside \`when\`/\`unless\` expression
  strings.
- **The silent no-op** — a scope naming an absent entity type *parses*, and
  Cedar's request-envelope resolver answers "success, nothing". The policy is
  well-formed, deployable, and can never fire.

## Cross-domain checks

The differentiator, and the thing no Cedar tool can express: Cedar only ever
sees policies, while a chant build holds the policies *and* the infrastructure
they govern in one entity graph. So a post-synth check can span both:

- an entity id in a policy references an actual resource declaration
- every declared bucket is covered by at least one \`forbid\`
- no schema action lacks any policy

These are ordinary post-synth checks. Nothing exotic — they just need both
halves in the same build, which is the arrangement chant already has.

## Coverage, two ways

\`\`\`bash
npx chant coverage --lexicon cedar     # schema -> generated artifacts
\`\`\`

The MCP tool asks the other half:

\`\`\`
cedar:coverage { "path": ".", "format": "text" }
\`\`\`

It builds the policy set, hands each policy to Cedar's own
\`getValidRequestEnvsPolicy\` alongside the schema, and reports:

| Field | Meaning |
|---|---|
| \`uncovered\` | Declarations no policy can apply to |
| \`forbidOnly\` | Declarations reachable only from a \`forbid\` — nothing grants them |
| \`inert\` | Policies whose request envelope is empty; they can never fire |
| \`unresolved\` | Policies the resolver rejected outright |
| \`parseErrors\` | Why the set would not split into policies |

Container entity types — the ones that appear in no action's \`appliesTo\` and
exist only to be \`in\` — show as uncovered even under a bare permit. That is
the resolver telling the truth: no request can name them.

## What is not here yet

The post-synth checks encoding all of the above are
[INTENTIUS/chant#1651](https://github.com/INTENTIUS/chant/issues/1651). Today
the lexicon ships the source-level rule set and the validation plumbing; the
checks that span policies and estate land there.
`;

// ── importing ─────────────────────────────────────────────────────

const importingPage = `Bringing an existing Cedar policy set into typed source, and pulling console edits back.

## The round trip

\`\`\`
.cedar text  ->  JSON policy format  ->  TypeScript  ->  .cedar text
\`\`\`

The JSON policy format is the parse source, not the \`.cedar\` text. That is why
the serializer produces it from the same structured model rather than by
re-parsing what it just wrote: the two views cannot drift, and the import path
reads a format with an actual grammar rather than doing a second parse of the
surface syntax.

\`cedar-wasm\` converts in both directions — \`policyToJson\`, \`policyToText\`,
\`policySetTextToParts\` — so a set that exists only as \`.cedar\` text is one
call away from the importable form.

## What round-tripping has to preserve

| Carried | Notes |
|---|---|
| Effect | \`permit\` / \`forbid\` |
| All three scope positions | Including \`is T in E\` |
| \`when\` / \`unless\` clauses | In order |
| Annotations | Including \`@id\`, which becomes the export name's override |

The one asymmetry today is condition bodies. The JSON policy format wants an
expression *tree*; the model carries expression *text*, written as
\`{ "__expr": "…" }\` — Cedar's own escape for a source-given expression.
Producing real trees means parsing Cedar expression text, which is precisely
the work the import path has to do anyway.

## Reconcile

The interesting case is not the initial import. It is the policy somebody edited
in a console: a \`ReconcileOp\` pulls it back into source, and the diff is
reviewable.

An **ambient permit** — one found in a policy store that no source file declares
— is not housekeeping. It is a standing grant somebody made outside review, and
it is a security finding.

## Ownership

AVP policy *stores* are taggable; individual policies are not. The ownership
channel is store-scoped until finer granularity is proven, and no channel is
declared until its read paths are implemented — \`chant dev check-lexicon\` has
a tier-2 gate for exactly the failure of declaring a marker channel on a path
the plugin does not implement.

## Status

The JSON policy-format parser, the TypeScript generator, and the
\`ReconcileOp\` example are
[INTENTIUS/chant#1653](https://github.com/INTENTIUS/chant/issues/1653). The
serializer already emits the format they read, which is why it exists as a
first-class output rather than a debugging aid.
`;

// ── avp ───────────────────────────────────────────────────────────

const avpPage = `Amazon Verified Permissions is one deployment vehicle for Cedar. It is not the only one, and the lexicon does not privilege it.

## The seam

chant already ships the deployment half. \`AWS::VerifiedPermissions::Policy\` in
the [aws lexicon](/chant/lexicons/aws/) carries its policy text in
\`definition.static.statement\`, typed \`CedarPolicy\` — which is to say,
\`string\`. That string is the seam.

\`\`\`
cedar lexicon                        aws lexicon
schema -> Policy -> .cedar text  ->  VerifiedPermissionsPolicy.definition.static.statement
\`\`\`

Everything upstream of the string — the schema, entity types, actions, scope
constraints — belongs to this lexicon. Everything downstream — the policy
store, the CloudFormation \`ApplyOp\`, the IAM around it — belongs to the aws
lexicon and already works.

## What ships today

A policy's statement text is what the serializer emits for that one entity —
the same bytes as the \`.cedar\` file, so the deployed policy and the reviewed
file cannot disagree.

\`\`\`typescript
import { Policy, ReadAction } from "@intentius/chant-lexicon-cedar";

export const ownerRead = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { eq: ReadAction },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal"],
});
\`\`\`

The \`avp-embedding\` init template scaffolds a multi-tenant store's schema and
a three-policy set shaped for one.

## What is deferred

A typed handoff — a \`VerifiedPermissionsPolicy\` whose \`statement\` accepts a
\`Policy\` value directly rather than a string a caller assembled — is landing
with [INTENTIUS/chant#1652](https://github.com/INTENTIUS/chant/issues/1652),
along with \`describeResources()\`/\`observeAmbient()\` against a live policy
store and the ownership-channel design.

Until it does:

- **Do not hand-type a statement string.** A prose
  \`"permit(principal, action, resource);"\` inside an AVP resource is exactly
  what this lexicon exists to remove, and the bare-permit wall fails it in a
  prod build.
- **Do not tag individual policies for ownership.** Stores are taggable;
  policies are not.
- **Treat an ambient permit as a finding.** A permit in a store that no source
  file declares is a standing grant made outside review.

## The other evaluators

If the target is not AVP there is no embedding step at all — emit the files and
ship them.

| Target | How |
|---|---|
| cedar-agent | Point it at the emitted \`.cedar\` and an entity store |
| Embedded \`cedar-wasm\` | Load the policy text in-process, call \`isAuthorized\` |
| Edge / Cloudflare-style | The same file, read at the edge |

## Cedar for Kubernetes

The CNCF push includes Cedar as a Kubernetes authorizer with policies as CRDs.
Those kinds belong to the [k8s lexicon](/chant/lexicons/k8s/)'s CRD sources —
the same rule that kept \`helm.cattle.io\` out of k3s. What this lexicon does
there is lint the policy text embedded in those kinds, the pattern the ARGO
rules already use.
`;

// ── Output format, for the generated serialization page ───────────

const outputFormat = `The cedar lexicon emits two views of one policy set.

**\`<name>.cedar\`** — the primary output, and the surface every Cedar evaluator reads.

\`\`\`cedar
@id("owner-read")
@doc("Owners always read their own documents.")
permit (
  principal is App::User,
  action in [App::Action::"read", App::Action::"list"],
  resource is App::Document
)
when { resource.owner == principal };
\`\`\`

**\`policies.cedar.json\`** — the Cedar JSON policy format, written alongside.

\`\`\`json
{
  "staticPolicies": {
    "owner-read": {
      "effect": "permit",
      "principal": { "op": "is", "entity_type": "App::User" },
      "action": { "op": "in", "entities": [{ "type": "App::Action", "id": "read" }] },
      "resource": { "op": "is", "entity_type": "App::Document" },
      "conditions": [{ "kind": "when", "body": { "__expr": "resource.owner == principal" } }],
      "annotations": { "id": "owner-read" }
    }
  },
  "templates": {},
  "templateLinks": []
}
\`\`\`

Both come from the same structured model in one pass, so they cannot drift. The
JSON form is also the parse source for import — see [Importing](../importing/).
`;

/**
 * Generate the docs site for the cedar lexicon.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const config: DocsConfig = {
    name: "cedar",
    displayName: "Cedar",
    description: "Typed authoring for Cedar authorization policies",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    srcDir: join(pkgDir, "src"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/cedar/",
    overview,
    outputFormat,
    // Cedar declarations are namespaced `App::Document` and
    // `App::Action::"read"`, so the first segment is the namespace — which is
    // the only grouping a Cedar schema has.
    serviceFromType: (type: string) => type.split("::")[0] ?? type,
    extraPages: [
      {
        slug: "getting-started",
        title: "Getting Started",
        description: "Scaffold, generate, build — in that order.",
        content: gettingStarted,
      },
      {
        slug: "schema",
        title: "Schema",
        description: "The .cedarschema this lexicon's codegen reads, and how it is resolved.",
        content: schemaPage,
      },
      {
        slug: "resources",
        title: "Resources",
        description: "Policy, and the entity and action declarations generated from your schema.",
        content: resourcesPage,
      },
      {
        slug: "policies",
        title: "Policies",
        description: "Policy props, scope forms, conditions, annotations, and ids.",
        content: policiesPage,
      },
      {
        slug: "composites",
        title: "Composites",
        description: "OwnerCanManage and DenyByDefaultSet — the shapes Cedar has nowhere to put.",
        content: compositesPage,
      },
      {
        slug: "lint-rules",
        title: "Lint Rules",
        description: "The bare-permit wall, schema-absent references, and cross-domain checks.",
        content: lintRulesPage,
      },
      {
        slug: "importing",
        title: "Importing",
        description: "The JSON policy format round trip, reconcile, and ownership.",
        content: importingPage,
      },
      {
        slug: "avp",
        title: "Verified Permissions",
        description: "The AVP statement seam, and the other Cedar evaluators.",
        content: avpPage,
      },
      // The dogwood dialect (#1662). `sidebar: false` on each, because these
      // five belong under one group rather than flat after the cedar pages —
      // the group is declared in `sidebarExtra` below, and `buildSidebar`
      // would otherwise list them twice.
      {
        slug: "dogwood",
        title: "The Dogwood Dialect",
        description: "Cedar with temporal operators — what ships, and what pre-release means here.",
        content: dogwoodOverview,
        sidebar: false,
      },
      {
        slug: "dogwood-temporal-policies",
        title: "Temporal Policies",
        description: "The typed builders, the parser primitives, and which operators are really macros.",
        content: dogwoodTemporalPolicies,
        sidebar: false,
      },
      {
        slug: "dogwood-event-schemas",
        title: "Event Schemas",
        description: "The .dwschema surface, the callerPrincipal pin, and what opting out of it widens.",
        content: dogwoodEventSchemas,
        sidebar: false,
      },
      {
        slug: "dogwood-validation",
        title: "Dogwood Validation",
        description: "The DWD walls that always run, and the CLI-gated checks that need the binary.",
        content: dogwoodValidation,
        sidebar: false,
      },
      {
        slug: "dogwood-replay",
        title: "Replay",
        description: "Typed traces, PolicyReplayOp, and the both-bags trap that makes half a trace pass.",
        content: dogwoodReplay,
        sidebar: false,
      },
    ],
    sidebarExtra: [
      {
        label: "Dogwood",
        items: [
          { label: "The Dialect", slug: "dogwood" },
          { label: "Temporal Policies", slug: "dogwood-temporal-policies" },
          { label: "Event Schemas", slug: "dogwood-event-schemas" },
          { label: "Validation", slug: "dogwood-validation" },
          { label: "Replay", slug: "dogwood-replay" },
        ],
      },
    ],
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error(
      `Generated docs: ${result.pages.size} pages, ${result.stats.resources} resources, ` +
        `${result.stats.properties} property types, ${result.stats.rules} rules`,
    );
  }
}
