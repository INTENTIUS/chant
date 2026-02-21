import { Rule, Job, Image, Environment, CI } from "@intentius/chant-lexicon-gitlab";

// Only on merge requests
export const onMR = new Rule({ if: CI.MergeRequestIid });

// Only on default branch
export const onMain = new Rule({
  if: `${CI.CommitBranch} == ${CI.DefaultBranch}`,
});

// Only on tags
export const onTag = new Rule({ if: CI.CommitTag });

// Dynamic environment naming
export const reviewDeploy = new Job({
  stage: "deploy",
  environment: new Environment({
    name: `review/${CI.CommitRef}`,
    url: `https://${CI.CommitRef}.preview.example.com`,
  }),
  script: ["deploy-preview"],
});

// Container registry
export const buildImage = new Job({
  stage: "build",
  image: new Image({ name: "docker:24" }),
  script: [
    `docker build -t ${CI.RegistryImage}:${CI.CommitSha} .`,
    `docker push ${CI.RegistryImage}:${CI.CommitSha}`,
  ],
});
