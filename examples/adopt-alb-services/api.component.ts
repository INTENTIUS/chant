import { phase, stackOutput, type Component } from "@intentius/chant/components";

/**
 * The `api` service, as one build.json — the whole `build-api` + `deploy-api`
 * pair from before/.gitlab-ci.yml, minus the shell.
 *
 * Where the shared-alb values come from is the crux. The bespoke pipeline ran
 * `describe-stacks | jq -r 'select(.OutputKey=="ListenerArn")'` at deploy time.
 * Here each one is a named cross-stack reference; the driver resolves it from
 * the deployed shared-alb stack. No `aws cloudformation describe-stacks`, no
 * `jq`, no `grep`. This block is identical in ui.component.ts — shared, not
 * copied-per-pipeline.
 */
const fromSharedAlb = {
  clusterArn: stackOutput("shared-alb", "ClusterArn"),
  listenerArn: stackOutput("shared-alb", "ListenerArn"),
  albSgId: stackOutput("shared-alb", "AlbSgId"),
  executionRoleArn: stackOutput("shared-alb", "ExecutionRoleArn"),
  vpcId: stackOutput("shared-alb", "VpcId"),
  privateSubnet1: stackOutput("shared-alb", "PrivateSubnet1"),
  privateSubnet2: stackOutput("shared-alb", "PrivateSubnet2"),
};

export const api: Component = {
  name: "api",
  archetype: "service",
  dependsOn: ["shared-alb"],
  deploy: [
    // build once into the archive; the exact bytes are what deploys.
    phase("Build", [
      { kind: "docker-build", context: "./api", into: "api.tar" },
    ]),
    // promote the built image by digest — no rebuild per environment. The
    // destination repo is shared-alb's ApiRepoUri output, the same value the
    // bespoke pipeline pulled with `jq '... ApiRepoUri'`.
    phase("Publish", [
      { kind: "publish-image", from: "archive:api.tar", to: stackOutput("shared-alb", "ApiRepoUri") },
    ]),
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "api",
        template: "dist/api.template.json",
        // the shared-alb outputs + the just-published image, wired in —
        // the driver fills these template parameters, not a shell heredoc.
        inputs: { ...fromSharedAlb, image: "@Publish.uri" },
      },
    ]),
    // the bespoke pipeline fires and forgets; the component waits for the
    // rollout to reach steady state before it reports success.
    phase("Verify", [
      { kind: "wait-steady-state", service: "api", cluster: stackOutput("shared-alb", "ClusterArn") },
    ]),
  ],
};
