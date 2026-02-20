import * as _ from "./_";

// Only on merge requests
export const onMR = new _.Rule({ ifCondition: _.CI.MergeRequestIid });

// Only on default branch
export const onMain = new _.Rule({
  ifCondition: `${_.CI.CommitBranch} == ${_.CI.DefaultBranch}`,
});

// Only on tags
export const onTag = new _.Rule({ ifCondition: _.CI.CommitTag });

// Dynamic environment naming
export const reviewDeploy = new _.Job({
  stage: "deploy",
  environment: new _.Environment({
    name: `review/${_.CI.CommitRef}`,
    url: `https://${_.CI.CommitRef}.preview.example.com`,
  }),
  script: ["deploy-preview"],
});

// Container registry
export const buildImage = new _.Job({
  stage: "build",
  image: new _.Image({ name: "docker:24" }),
  script: [
    `docker build -t ${_.CI.RegistryImage}:${_.CI.CommitSha} .`,
    `docker push ${_.CI.RegistryImage}:${_.CI.CommitSha}`,
  ],
});
