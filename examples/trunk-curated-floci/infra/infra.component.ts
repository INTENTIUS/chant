import { gate, phase, type Component } from "@intentius/chant/components/component";
import { cfnDeploy } from "@intentius/chant-lexicon-aws/components";

// One stack per environment: the cut and the deploy set CHANT_ENV, so staging
// and prod get stacks of their own. The gate makes each promote wait on an
// approval of the release's change set for that environment.
const env = process.env.CHANT_ENV ?? "local";

export const infra: Component = {
  name: "infra",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Approve", [gate("release", { description: "Approve this release for the environment." })]),
    phase("Apply", [cfnDeploy({ stack: `trunk-curated-${env}`, template: "template.json" })]),
  ],
};
