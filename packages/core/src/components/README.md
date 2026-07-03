# Component contract schema

`component.schema.json` is the portable JSON Schema (draft 2020-12) for the
**Component contract** described in the
[Components docs](../../../../docs/src/content/docs/components/) —
specifically
[`component-contract.mdx`](../../../../docs/src/content/docs/components/component-contract.mdx)
(fields, archetypes, the JSON projection) and
[`composition-and-wiring.mdx`](../../../../docs/src/content/docs/components/composition-and-wiring.mdx)
(the phase grammar, fan-out, and wiring reference forms). Those docs are
authoritative over this schema's prose; the schema is authoritative over the
document *shape*.

## This schema is the substrate, not a chant-only type

A component is declarative data. chant's TypeScript authoring form (`Component`,
`phase()`, capability builders, etc. — tracked separately, see #551 "Chant-native
plugin" phase) is one typed frontend that **projects to** this JSON document. A
non-chant or legacy component can hand-write this JSON directly and be driven
by the same generic orchestrator, with no chant authoring step required. Making
the contract a portable spec rather than a runtime-only object is what keeps
walk-away cost low: nothing about participating in the release model requires
adopting chant.

## What it models

- **Identity and ordering** — `name`, `dependsOn` (ordering only, resolved by
  `chant graph --stacks`, no logic).
- **The three archetypes** — service (build → publish → apply → verify),
  infra (apply → verify, no build), and producer/library (build → publish
  only, no service apply). `deploy` being a plain composition is what makes
  build-only and apply-only shapes first-class rather than special cases.
- **The composition grammar** — `deploy` is an ordered list of `Phase`s;
  phases carry `steps` (capability invocations), an optional `parallel` flag,
  and an optional `onFailure` for saga-style compensation. A step may itself
  be a nested `Phase`, which is how fan-out (e.g. a Neo4j cluster seeding one
  node then rolling through the rest) is expressed as composition rather than
  orchestrator knowledge.
- **Gates** — a distinct step shape (`kind: "gate"`, `signalName`) for a
  durable, human-approval wait.
- **Wiring reference forms**, all resolved by the graph, never by orchestrator
  code:
  - `$env.<path>` — environment config (e.g. `$env.registry`).
  - `@<Phase>.<field>` — a prior step's output within the same component
    (e.g. `@Publish.digest`).
  - `@<component>.publish.uri|digest|key` — another component's published
    artifact output (e.g. `@jar-lib.publish.uri`); the referenced component
    must appear in `dependsOn`.
  - `{ "stackOutput": { "stack", "name" } }` — a cross-stack
    CloudFormation/ARM/... output, the JSON-side equivalent of the
    TypeScript `stackOutput()` mechanism.

Capability-specific step properties (beyond the cross-cutting wiring-typed
ones like `imageRef`/`jar`/`revision`/`inputs`) are intentionally left open
(`additionalProperties: true` on `Step`). The capability interface and its
per-verb input/output types are the subject of a separate spec (#554); this
schema only needs every capability invocation to be representable as
`{ kind, ...params }`.

## Versioning

- `$id` is stable: `https://intentius.io/chant/schemas/component/v1/component.schema.json`.
  A breaking change to the contract gets a new `v2` path; this file does not
  change shape incompatibly in place.
- `contractVersion` (currently pinned to `"1.0.0"`) is the document-level
  version field a hand-written component can assert against.

## Fixtures and tests

`__fixtures__/` holds real components drawn from the epic (#551): an ALB/ECS
service, a DynamoDB table, a Neo4j fan-out cluster, a JAR producer and its EMR
consumer, a single-host Docker Compose service, and (#558) a container-image
Lambda function. `component-schema.test.ts` validates every fixture against
`component.schema.json` with [ajv](https://ajv.js.org/) (`ajv/dist/2020` — the
draft 2020-12 build) and exercises the schema's negative cases (missing
required fields, malformed wiring references, an invalid archetype, a gate
missing `signalName`, and so on).

## Typed authoring form (`component.ts`, #560)

`component.ts` is the real typed `Component` authoring frontend the docs
describe: `Component`, `Phase`, `Step`, `Gate`, `BuildSpec`, `Wiring` mirror
this schema's `$defs` field-for-field, plus the `phase()`/`gate()`/
`stackOutput()` builders and `projectToJson()` (the mechanical TS → JSON
projection, filling in `archetype` via `inferArchetype` when a component
doesn't set one explicitly — see the archetype table above). It supersedes
the Phase 1 stopgap `pilots/authoring-shape.ts` (deleted), which explicitly
deferred the real API to this issue.

## Discovery (`discover.ts`, #560)

`discoverComponents(path)` finds every `Component` declared under a
directory, mirroring chant's existing declarable discovery
(`../discovery/index.ts`) as closely as a structurally distinct type allows,
and borrowing its file-suffix convention from Op discovery
(`../op/discover.ts`'s `*.op.ts`): any `.component.ts` file (excluding
`.test.component.ts`/`.spec.component.ts`) is scanned, every export
satisfying `isComponent` is collected (any export name, not just `default`,
so one file may declare several related components), and a duplicate
`component.name` across files is a discovery error — the same duplicate-name
discipline `collectEntities`/`discoverOps` already apply to resources/Ops.
`*.component.ts` was chosen over reusing the generic `.ts` + `Declarable`
marker convention because a `Component` has no `lexicon`/`entityType` shape
to tag; see `discover.ts`'s docstring for the full reasoning.

## Pilots

`pilots/` (#555) authors three of those fixtures — the ALB/ECS service, the
DynamoDB table, and the Neo4j fan-out cluster — a second way: as TypeScript
authored against `component.ts`, composed from the real capability verbs in
`verbs/`. Each pilot's JSON projection is asserted equal to its
`__fixtures__/*.json` counterpart, so the fixture stays the one authoritative
JSON document; see `pilots/README.md` for the axis-by-axis mapping (build vs
no-build, single vs fan-out, sticky vs simple apply, cross-stack wiring, auto
vs no rollback).

`pilots/lambda.pilot.ts` (#558) adds a fourth component the same way — a
container-image Lambda function — to validate the sprawl metric holds beyond
the three pilots that were picked specifically to prove it. See
[`SPRAWL-VALIDATION.md`](./SPRAWL-VALIDATION.md) for the full write-up: the
before/after against the ALB/ECS pipeline's `describe-stacks | jq` glue, and
the per-component scorecard (new pipelines / driver edits / declarations /
capabilities) the epic's "definition of done" asks for.
