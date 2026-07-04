import { phase, type Component } from "@intentius/chant/components/component";
import { cfnDeploy } from "@intentius/chant/components";

// The release model: one component that applies the chant-synthesized template.
// `cfn-deploy` runs `aws cloudformation create-change-set → execute-change-set →
// wait`, so when the Apply phase completes the real stack exists. Infra archetype
// (no build, just apply); `template.json` is what `chant build` produced from src/.
export const infra: Component = {
  name: "demo-infra",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Apply", [
      cfnDeploy({ stack: "components-aws-e2e", template: "template.json" }),
    ]),
  ],
};
