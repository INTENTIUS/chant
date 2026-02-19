import * as _ from "./_";

export const build = new _.gl.Job({
  stage: "build",
  image: _.$.nodeImage,
  cache: _.$.npmCache,
  script: ["npm ci", "npm run build"],
  artifacts: _.$.buildArtifacts,
});

export const test = new _.gl.Job({
  stage: "test",
  image: _.$.nodeImage,
  cache: _.$.npmCache,
  script: ["npm ci", "npm test"],
  artifacts: _.$.testArtifacts,
});

// Cross-lexicon reference: deploy job uses the AWS bucket ARN.
// The AttrRef is a direct property value so the walker can detect it.
export const deploy = new _.gl.Job({
  stage: "deploy",
  image: _.$.nodeImage,
  script: ["aws s3 sync dist/ s3://$DEPLOY_BUCKET/"],
  variables: { DEPLOY_BUCKET: _.$.deployBucket.arn },
  rules: [_.$.onDefaultBranch],
});
