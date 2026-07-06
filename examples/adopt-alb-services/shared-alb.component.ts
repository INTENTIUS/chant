import { phase, type Component } from "@intentius/chant/components";

/**
 * The shared infrastructure, as one build.json: a VPC, an ALB + listener, an ECS
 * cluster, and the `alb-api`/`alb-ui` ECR repos — one CloudFormation stack. Its
 * outputs (ListenerArn, ClusterArn, subnets, the repo URIs) are what each
 * service attaches to.
 *
 * `infra` archetype — no build, just apply. The template is what
 * `chant build src/shared-alb` synthesized. In the bespoke pipeline these
 * outputs were fished back out at deploy time with `describe-stacks | jq`; here
 * the service components name them (`stackOutput("shared-alb", ...)`) and the
 * driver resolves them. Steps are written as plain `{ kind }` objects so every
 * field is visible — the same authoring form the pilots and docs use.
 */
export const sharedAlb: Component = {
  name: "shared-alb",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Apply", [
      { kind: "cfn-deploy", stack: "shared-alb", template: "dist/shared-alb.template.json" },
    ]),
  ],
};
