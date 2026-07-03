# Sprawl metric validation (#558, epic #551)

This validates the sprawl metric epic #551 defines as its "definition of
done" against the three real pilots (#555) plus a fourth, deliberately
different component added here. Everything below runs through the one
generic `runInterpretDriver` (#556, [`../driver.ts`](./driver.ts)), unchanged.

## The metric, from #551

> - Typical new component: 0 new pipelines, 0 orchestrator edits, 0 new capabilities, 1 declaration.
> - Genuinely novel component: 0 pipelines, 0 orchestrator edits, at most 1 new capability (then reusable), 1 declaration.
> - Cross-cutting change: 1 capability edited, 0 components touched.
> - The generic orchestrator contains zero per-component code (no `if component.name === ...`).
> - Three of our most-different real components run through one driver with no per-component driver code.

## Before / after: the ALB/ECS pipeline glue this replaces

The component model's whole reason for existing is visible in one concrete
diff. [`examples/gitlab-aws-alb-api/src/pipeline.ts`](../../../../../examples/gitlab-aws-alb-api/src/pipeline.ts)
hand-rolls a `deployService` job that shells out to CloudFormation and greps
its own infra stack's outputs before it can deploy:

```ts
// before — examples/gitlab-aws-alb-api/src/pipeline.ts (deployService job)
`OUTPUTS=$(aws cloudformation describe-stacks --stack-name ${INFRA_STACK} --query 'Stacks[0].Outputs' --output json)`,
`PARAMS=$(echo "$OUTPUTS" | jq -r '[(.[] | select(.OutputKey == "ClusterArn") | "clusterArn=" + .OutputValue), (.[] | select(.OutputKey == "ListenerArn") | "listenerArn=" + .OutputValue), ...] | join(" ")')`,
`IMAGE_URI=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey == "ApiRepoUri") | .OutputValue'):${CI_COMMIT_REF_SLUG}`,
`aws cloudformation deploy --template-file templates/template.json --stack-name ${STACK_NAME} ... --parameter-overrides $PARAMS image=$IMAGE_URI`,
```

That `describe-stacks | jq` line is bespoke per pipeline: every component that
imports another stack's outputs re-derives its own grep. The component-native
replacement ([`pilots/alb-ecs.pilot.ts`](./pilots/alb-ecs.pilot.ts)) expresses
the same import as typed cross-stack wiring, resolved by the graph rather than
scripted in the pipeline:

```ts
// after — pilots/alb-ecs.pilot.ts
const sharedAlbOutputs = {
  listenerArn: { stackOutput: { stack: "shared-alb", name: "ListenerArn" } },
  clusterArn: { stackOutput: { stack: "shared-alb", name: "ClusterArn" } },
  subnets: { stackOutput: { stack: "shared-alb", name: "Subnets" } },
};
// ...
{ kind: "cfn-deploy", template: "archive:search.template.json", imageRef: "@Publish.digest", inputs: sharedAlbOutputs }
```

No `describe-stacks`, no `jq`, no shell string-building. `dependsOn:
["shared-alb"]` plus three `stackOutput()` references replace the whole glue
block; `docker build`/`docker push` become the `docker-build`/`publish-image`
capabilities the driver dispatches to. [`driver.test.ts`](./driver.test.ts)
and [`pilots/pilots-e2e.test.ts`](./pilots/pilots-e2e.test.ts) exercise this
exact wiring end to end against a mock `CloudExecutor` — `cfn-deploy`
resolves the `stackOutput` reference itself; no orchestrator code parses a
CloudFormation output.

## The three pilots, unchanged, through the one driver

[`driver.test.ts`](./driver.test.ts)'s `"runs the three pilots through one
driver instance with zero per-component driver code (sprawl metric)"` test
(pre-existing from #556/#557, still green) and
[`pilots-e2e.test.ts`](./pilots/pilots-e2e.test.ts)'s first `describe` block
run Neo4j fan-out, DynamoDB (sticky apply), and ALB/ECS (cross-stack, build)
through the same `runInterpretDriver` call, dispatching to the real,
`MockCloudExecutor`-backed capability implementations from #557
(`docker-build`, `publish-image`, `cfn-deploy`, `ecs-update-service`,
`code-deploy`, `wait-for-stack`, `wait-steady-state`, `wait-cluster-healthy`).
Nothing in [`driver.ts`](./driver.ts) branches on which of the three is
running — dispatch is purely by step `kind` via `CapabilityRegistry.resolve`.

## The fourth component: image-processor-lambda

To validate the metric holds beyond the three pilots that were picked
specifically to prove it, this issue adds a fourth, deliberately different
component: [`pilots/lambda.pilot.ts`](./pilots/lambda.pilot.ts) /
[`__fixtures__/lambda-image-processor.json`](./__fixtures__/lambda-image-processor.json),
a container-image AWS Lambda function (`image-processor-lambda`).

It was picked over the single-host docker-compose fixture
([`__fixtures__/single-host-compose.json`](./__fixtures__/single-host-compose.json))
specifically because compose would have needed four still-stubbed
capabilities at once (`load-image-on-host`, `copy-to-host`, `remote-exec`,
`wait-endpoint`) to actually run — busting the "at most 1 new capability"
bound before it even started. Lambda needed exactly one.

What makes it genuinely different from the three pilots, not a shape
variation of ALB/ECS:

- **No CloudFormation at all in its apply step.** Every one of the three
  pilots (and `shared-alb`) applies via `cfn-deploy`. `image-processor-lambda`
  is the first component in the validation set whose Apply phase contains no
  `cfn-deploy` — it calls `UpdateFunctionCode` / `PublishVersion` /
  `UpdateAlias` directly against the function.
- **Alias-based promotion, not a stack changeset.** Verification/rollback
  reason about an alias pointer (`live` -> version N), not a stack status or a
  service's running/desired task count.

What it reuses unchanged (zero new capabilities here): `docker-build` and
`publish-image` — a container-image Lambda's build/publish story is
byte-identical to ALB/ECS's (build an image, promote it by digest into the
registry); the same `@Publish.uri` prior-step wiring form every pilot already
uses carries the image reference into the apply step.

### The one new capability: `lambda-deploy`

[`verbs/apply.ts`](./verbs/apply.ts)'s `createLambdaDeployCapability` is the
only new leaf this component required, built the same way #557 built the
other real leaves: typed input/output, an injectable `CloudExecutor`
(extended with a `lambda` client — [`verbs/cloud-executor.ts`](./verbs/cloud-executor.ts)),
a real shell-out implementation for production, and a `MockCloudExecutor`
implementation ([`verbs/__tests__/mock-cloud-executor.ts`](./verbs/__tests__/mock-cloud-executor.ts))
for tests. It declares a `rollback` (repoint the alias back to whatever
version it pointed at before this step ran) — the same best-effort,
capability-level compensation style `ecs-update-service` uses, since Lambda
has no native automatic rollback for a code update the way CodeFormation/
CodeDeploy do.

No other verb was touched or added. `driver.ts` was not edited.

### Proof it runs through the same driver

[`driver.test.ts`](./driver.test.ts)'s `"runs all four components ... through
one driver instance with zero per-component driver code (sprawl metric,
extended)"` test and [`pilots-e2e.test.ts`](./pilots/pilots-e2e.test.ts)'s
second `describe`-block test run all five components (`shared-alb`,
`orders-table`, `neo4j-cluster`, `search-service`, `image-processor-lambda`)
through one `runInterpretDriver` call, dispatching `image-processor-lambda`'s
steps to the real `lambda-deploy` capability against a shared
`MockCloudExecutor` — no live AWS.

## Scorecard

| Component | New pipelines | Driver edits | New declarations | New capabilities | Reused capabilities |
|---|---|---|---|---|---|
| Neo4j fan-out (#555) | 0 | 0 | 1 | 0 (#557 implemented the pilot set together) | `cfn-deploy`, `code-deploy`, `wait-cluster-healthy` |
| DynamoDB (#555) | 0 | 0 | 1 | 0 | `cfn-deploy`, `wait-for-stack` |
| ALB/ECS (#555) | 0 | 0 | 1 | 0 | `docker-build`, `publish-image`, `cfn-deploy`, `ecs-update-service`, `wait-steady-state` |
| **image-processor-lambda (#558, this issue)** | **0** | **0** | **1** | **1** (`lambda-deploy`) | `docker-build`, `publish-image` |

Read row-by-row against the metric: every component is one declaration, zero
new pipelines, zero driver edits. The fourth component needed exactly one new
capability — inside the "genuinely novel: at most 1" bound, not the
"typical: 0" bound the three original pilots hit, which is the honest result
for a component that introduces a capability family (Lambda code deploy) none
of the three pilots exercised.

## Blockers found: none

No case forced a per-component branch in `driver.ts`. `driver.ts` was not
modified by this issue — every dispatch (`runCapabilityStep`, `runPhase`,
`resolveWiring`) already operates purely on the generic
`Component`/`Phase`/`Step` shapes and the `kind` string, with no branch naming
a specific component or capability. The fourth component's differences (no
`cfn-deploy` in Apply, alias-based promotion) required a new *capability*,
which is exactly where the epic says new behavior should land — never a new
capability *forced a driver change* to accommodate it.

If a future component needs multiple new capabilities at once (as
single-host compose would — four stubs), that is not by itself a driver
special-case; it just means that component was not the cheapest pick for a
minimal walkthrough. `load-image-on-host` / `copy-to-host` / `remote-exec` /
`wait-endpoint` remain typed stubs (`../capability.ts`'s "no cloud
implementation yet" contract) — implementing them is future capability work,
out of scope for this validation issue, and does not block the metric: the
schema/fixture already validates that composition
([`component-schema.test.ts`](./component-schema.test.ts)), only the cloud
leaves are unimplemented.

## Assumptions

- `lambda-deploy`'s `codeRef` carries a container image URI (this issue's
  chosen shape), not a zip/S3 key — `zip-package` stays a stub, so a
  zip-packaged Lambda was not in scope; a container-image Lambda was the
  cheaper, still-genuinely-novel choice.
- `health-gate` in the Lambda pilot's Verify phase remains a typed stub (as it
  already was for the ALB/ECS pilot) — verifying this issue is about apply
  dispatch (`lambda-deploy`), not the wait/verify family.
- The Lambda pilot has no component-level `rollback` field (unlike ALB/ECS):
  `lambda-deploy`'s own capability-level rollback (restore the alias) is
  sufficient here, so no explicit compensation phase was added to the
  declaration.
