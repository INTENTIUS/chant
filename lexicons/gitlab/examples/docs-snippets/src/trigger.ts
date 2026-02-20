import { Job, Trigger } from "@intentius/chant-lexicon-gitlab";

export const deployInfra = new Job({
  stage: "deploy",
  trigger: new Trigger({
    project: "my-group/infra-repo",
    branch: "main",
    strategy: "depend",
  }),
});
