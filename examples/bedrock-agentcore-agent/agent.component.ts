import { phase, type Component } from "@intentius/chant/components";

/**
 * The base path from #882: apply the CloudFormation template `chant build
 * src` synthesizes, then wait for the stack to settle. `cfn-deploy` +
 * `wait-for-stack` are both existing aws-lexicon capabilities — no bespoke
 * verb. `archetype: "infra"` matches shared-alb.component.ts in
 * adopt-alb-services: no build, just apply.
 *
 * The `agentcore-deploy` version-promotion capability this component would
 * eventually add a "Promote" phase for (repointing `RuntimeEndpoint` to a new
 * `Runtime` version) is deferred — see the README's "What's deferred"
 * section. It is gated on Bedrock AgentCore Runtime reaching GA, not on this
 * example.
 */
export const agent: Component = {
  name: "bedrock-agentcore-agent",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Apply", [
      { kind: "cfn-deploy", stack: "bedrock-agentcore-agent", template: "dist/agent.template.json" },
    ]),
    phase("Verify", [
      { kind: "wait-for-stack", stack: "bedrock-agentcore-agent" },
    ]),
  ],
};
