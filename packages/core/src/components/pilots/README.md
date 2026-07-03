# Pilot component definitions

Three concrete components authored against the [Component contract](../../../../../docs/src/content/docs/components/component-contract.mdx), picked (epic [#551](https://github.com/INTENTIUS/chant/issues/551)) to be the three most-different real components chant deploys today. Each is provided as:

- an **illustrative TypeScript authoring form** (`*.pilot.ts`) — composed using the real capability `kind` verbs and typed inputs from [`../verbs`](../verbs/), against a local authoring shape (`authoring-shape.ts`) that mirrors `component.schema.json` field-for-field. There is no typed `Component`/`phase()` authoring frontend yet (that lands in Phase 2, [#560](https://github.com/INTENTIUS/chant/issues/560)); this shape is deliberately the minimum needed to author a real composition in TypeScript today, not a preview of that API.
- its **JSON projection** (`project.ts` + [`pilots.test.ts`](./pilots.test.ts)) — asserted equal to the existing fixture in [`../__fixtures__/`](../__fixtures__/) that already validates against the schema ([#553](https://github.com/INTENTIUS/chant/issues/553)/[#571](https://github.com/INTENTIUS/chant/pull/571)). The fixture stays the one authoritative JSON document per pilot; this directory does not fork a second copy.

## Mapping to the epic's axes

The epic ([#551](https://github.com/INTENTIUS/chant/issues/551)) picked these three specifically to exercise different points on each axis at once, so three components prove more than three would if they were shape-variations of each other.

| Pilot | File / fixture | build vs no-build | single vs fan-out | sticky vs simple apply | cross-stack wiring | auto vs no rollback |
|---|---|---|---|---|---|---|
| **Neo4j per-instance fan-out** | [`neo4j-fanout.pilot.ts`](./neo4j-fanout.pilot.ts) / [`neo4j-fanout.json`](../__fixtures__/neo4j-fanout.json) | no-build (`infra`, applies pre-built templates) | **fan-out** — one component composes 3 per-instance mini-compositions (`cfn-deploy` + `code-deploy` + `wait-cluster-healthy`), seed-first then rolling, gated at node 1 | simple apply (no `onReplace`/`stageGsi` — no sticky CFN concerns here) | none (self-contained cluster, no shared-stack imports) | **auto** — `code-deploy` (AWS CodeDeploy) rollback is native/automatic on failure, declared once inside the capability, never scripted per node |
| **DynamoDB table** | [`dynamodb.pilot.ts`](./dynamodb.pilot.ts) / [`dynamodb-infra.json`](../__fixtures__/dynamodb-infra.json) | no-build (`infra`, applies an existing table template) | single (one `cfn-deploy`, no fan-out) | **sticky** — `onReplace: "block"` refuses a replacing changeset (data loss guard); `stageGsi: true` stages the GSI add→backfill→remove instead of an in-place replace | none | no rollback declared — a blocked replacement is not something to compensate, it is a stop |
| **ALB/ECS target** | [`alb-ecs.pilot.ts`](./alb-ecs.pilot.ts) / [`alb-ecs-service.json`](../__fixtures__/alb-ecs-service.json) | **build** — `docker-build` → `publish-image` (promote by digest at deploy time) | single (one service, one `cfn-deploy` + `ecs-update-service`) | simple apply (no replacement-sensitive resource here) | **cross-stack** — imports `shared-alb`'s `ListenerArn`/`ClusterArn`/`Subnets` via `stackOutput()`, replacing the `describe-stacks \| jq` glue in [`examples/gitlab-aws-alb-api/src/pipeline.ts`](../../../../../examples/gitlab-aws-alb-api/src/pipeline.ts) | **no** (component-declared) — `ecs-update-service`/`cfn-deploy` have no native automatic rollback for an already-running service swap, so the component supplies an explicit `rollback` phase (`rollback-previous`) rather than relying on capability compensation |

Read together, the three cover every cell at least once: build only shows up for ALB/ECS, fan-out only for Neo4j, sticky-apply only for DynamoDB, cross-stack only for ALB/ECS, and both rollback styles (capability-native vs component-declared) appear once each.

## A fourth component (#558): image-processor Lambda

[`lambda.pilot.ts`](./lambda.pilot.ts) / [`lambda-image-processor.json`](../__fixtures__/lambda-image-processor.json) adds a fourth component, added after the three above to validate the sprawl metric ([#551](https://github.com/INTENTIUS/chant/issues/551)#definition-of-done-the-sprawl-metric), not to re-cover the same axes. It reuses `docker-build`/`publish-image` unchanged (build + promote-by-digest is identical to ALB/ECS's) but its Apply phase dispatches to `lambda-deploy` instead of `cfn-deploy` — the first component in the set with no CloudFormation stack in its apply step at all. `lambda-deploy` was the one new capability this component needed; see [`../SPRAWL-VALIDATION.md`](../SPRAWL-VALIDATION.md) for the full accounting and the ALB/ECS pipeline-glue before/after.

## Why the fixture is authoritative, not this directory

[#555](https://github.com/INTENTIUS/chant/issues/555) explicitly scopes "committed under an `examples/` or `fixtures/` path" — the schema's own `__fixtures__/` already holds real components drawn from this epic, including these three. Duplicating them here as a second JSON copy would immediately be the "composition copy-paste" / definition-sprawl failure mode the epic itself guards against ([#551](https://github.com/INTENTIUS/chant/issues/551)#failure-modes). Instead:

- `../__fixtures__/*.json` remains the one JSON document per pilot, already covered by [`../component-schema.test.ts`](../component-schema.test.ts).
- This directory adds the TypeScript authoring form the issue also asks for, and [`pilots.test.ts`](./pilots.test.ts) asserts the two never drift apart — if a pilot's composition changes, the fixture is the file to update, and the test fails loudly if only one side moves.

## What's out of scope here

Per the issue: running these compositions (the [Phase 1 driver](https://github.com/INTENTIUS/chant/issues/556)) and real capability implementations ([#557](https://github.com/INTENTIUS/chant/issues/557)) are separate issues. Every capability referenced below is still a typed stub (see [`../verbs/`](../verbs/)) — `run()`/`rollback()` throw `CapabilityNotImplementedError`. Nothing here executes anything.
