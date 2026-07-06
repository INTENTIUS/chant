import { phase, stackOutput, type Component } from "@intentius/chant/components";

/**
 * The `ui` service. This is the adoption payoff: a second service is a second
 * build.json, not a second pipeline. Compare this file to api.component.ts —
 * same shape, same capabilities, same shared-alb wiring block. The only
 * differences are the name, the build context, its stack, and its route.
 *
 * In before/.gitlab-ci.yml, adding `ui` meant copying the whole `build-*` +
 * `deploy-*` pair — the `describe-stacks | jq` glue and all — and maintaining
 * the copy forever. Here nothing new is orchestrated; the same generic driver
 * runs one more declaration.
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

export const ui: Component = {
  name: "ui",
  archetype: "service",
  dependsOn: ["shared-alb"],
  deploy: [
    phase("Build", [
      { kind: "docker-build", context: "./ui", into: "ui.tar" },
    ]),
    phase("Publish", [
      { kind: "publish-image", from: "archive:ui.tar", to: stackOutput("shared-alb", "UiRepoUri") },
    ]),
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "ui",
        template: "dist/ui.template.json",
        inputs: { ...fromSharedAlb, image: "@Publish.uri" },
      },
    ]),
    phase("Verify", [
      { kind: "wait-steady-state", service: "ui", cluster: stackOutput("shared-alb", "ClusterArn") },
    ]),
  ],
};
