/**
 * Pilot: ALB/ECS target (#555, epic #551).
 *
 * Exercises the build + cross-stack + auto-rollback axes: `docker-build` →
 * `publish-image` (promote by digest, deploy-time) → `cfn-deploy` (importing
 * the shared ALB's listener/cluster/subnets as cross-stack outputs, resolved
 * by `chant graph --stacks` rather than a `describe-stacks | jq` pipeline
 * step — see composition-and-wiring.mdx#cross-stack-outputs) →
 * `ecs-update-service` → `wait-steady-state` + `health-gate`.
 *
 * This is the direct component-native replacement for the hand-rolled GitLab
 * pipeline in `examples/gitlab-aws-alb-api/src/pipeline.ts`: the
 * `describe-stacks`/`jq` glue in that pipeline's `deployService` job is
 * exactly the cross-stack `stackOutput()` wiring below, and its
 * `docker build`/`docker push` steps are the `docker-build` + `publish-image`
 * capabilities. `service` archetype: build → publish → apply → verify, the
 * fullest of the three archetypes.
 *
 * The JSON projection of this pilot is authoritative at
 * ../__fixtures__/alb-ecs-service.json (already schema-validated by
 * component-schema.test.ts) — this module is the real typed `Component`
 * authoring form (#560, ../component.ts) that composes to that same
 * document; see ./pilots.test.ts, which asserts the two never diverge.
 */

import type { Component } from "../component";
import { phase, stackOutput } from "../component";

/** The shared ALB stack's exported outputs this service imports — the cross-stack wiring axis. */
const sharedAlbOutputs = {
  listenerArn: stackOutput("shared-alb", "ListenerArn"),
  clusterArn: stackOutput("shared-alb", "ClusterArn"),
  subnets: stackOutput("shared-alb", "Subnets"),
};

export const searchService: Component = {
  name: "search-service",
  archetype: "service",
  dependsOn: ["shared-alb"],
  build: { kind: "docker-build", context: ".", into: "archive" },
  deploy: [
    phase("Publish", [{ kind: "publish-image", from: "archive", to: "$env.registry" }]),
    phase("Apply", [
      {
        kind: "cfn-deploy",
        template: "archive:search.template.json",
        imageRef: "@Publish.digest",
        inputs: sharedAlbOutputs,
      },
      { kind: "ecs-update-service", cluster: "$env.cluster", service: "search" },
    ]),
    phase("Verify", [
      { kind: "wait-steady-state", service: "search" },
      { kind: "health-gate", path: "/healthz" },
    ]),
  ],
  // No native `rollback` on ecs-update-service/cfn-deploy for an already-running
  // service swap — the component declares an explicit compensation phase
  // (auto/no-rollback axis: this is the "no automatic capability rollback,
  // component supplies its own" side, contrasted with code-deploy's native
  // automatic rollback in the Neo4j pilot).
  rollback: [phase("Rollback", [{ kind: "rollback-previous", service: "search", cluster: "$env.cluster" }])],
};
