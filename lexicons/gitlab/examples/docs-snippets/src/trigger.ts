import * as _ from "./_";

export const deployInfra = new _.Job({
  stage: "deploy",
  trigger: new _.Trigger({
    project: "my-group/infra-repo",
    branch: "main",
    strategy: "depend",
  }),
});
