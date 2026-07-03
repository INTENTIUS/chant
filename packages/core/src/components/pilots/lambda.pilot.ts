/**
 * Pilot: image-processor Lambda (#558, epic #551).
 *
 * The fourth, deliberately different component #558 asks for, added to prove
 * the sprawl metric holds beyond the original three pilots (#555): a
 * container-image AWS Lambda function. `service` archetype, same as ALB/ECS,
 * but a genuinely different shape on two axes at once:
 *
 *  - **apply target**: no CloudFormation stack at all — `lambda-deploy`
 *    updates a function's code directly (`UpdateFunctionCode` +
 *    `PublishVersion` + `UpdateAlias`), never a `cfn-deploy` changeset. Every
 *    prior pilot's apply step was `cfn-deploy`; this is the first pilot whose
 *    Apply phase contains none.
 *  - **verify shape**: a single `wait-for-stack`-free health check
 *    (`health-gate` against the function's alias URL) rather than an ECS
 *    steady-state poll or a Neo4j quorum probe.
 *
 * Reuses `docker-build` + `publish-image` unchanged from the ALB/ECS pilot's
 * axis (build + promote-by-digest is identical for a container-image Lambda:
 * https://docs.aws.amazon.com/lambda/latest/dg/images-create.html) — the
 * `imageRef`/`codeRef` wiring (`@Publish.digest` / `@Publish.uri`) is the same
 * `@Phase.field` prior-step reference form every pilot already uses. The only
 * capability this component needed that didn't already exist is `lambda-deploy`
 * (../verbs/apply.ts) — one new capability, exactly the sprawl metric's bound
 * for "genuinely novel"; see ../SPRAWL-VALIDATION.md for the full accounting.
 *
 * The JSON projection of this pilot is authoritative at
 * ../__fixtures__/lambda-image-processor.json — this module is the real
 * typed `Component` authoring form (#560, ../component.ts) that composes to
 * that same document; see ./pilots.test.ts, which asserts the two never
 * diverge.
 */

import type { Component } from "../component";
import { phase } from "../component";

export const imageProcessor: Component = {
  name: "image-processor-lambda",
  archetype: "service",
  dependsOn: [],
  build: { kind: "docker-build", context: ".", into: "archive" },
  deploy: [
    phase("Publish", [{ kind: "publish-image", from: "archive", to: "$env.registry" }]),
    phase("Apply", [
      { kind: "lambda-deploy", functionName: "image-processor", codeRef: "@Publish.uri", alias: "live" },
    ]),
    phase("Verify", [{ kind: "health-gate", path: "@Apply.functionArn" }]),
  ],
  // No native rollback on lambda-deploy for an alias already repointed at a bad
  // version — same "no automatic capability rollback" story as the ALB/ECS
  // pilot's ecs-update-service, except here the capability itself supplies the
  // best-effort restore (see createLambdaDeployCapability's rollback in
  // ../verbs/apply.ts) rather than the component declaring its own phase, so
  // no component-level `rollback` field is needed here.
};
