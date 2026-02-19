import * as _ from "./_";

// --- AWS encryption & access config ---

export const encryptionDefault = new _.ServerSideEncryptionByDefault({
  sseAlgorithm: "AES256",
});

export const encryptionRule = new _.ServerSideEncryptionRule({
  serverSideEncryptionByDefault: encryptionDefault,
});

export const bucketEncryption = new _.BucketEncryption({
  serverSideEncryptionConfiguration: [encryptionRule],
});

export const publicAccessBlock = new _.PublicAccessBlockConfiguration({
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});

export const versioningEnabled = new _.VersioningConfiguration({
  status: "Enabled",
});

export const assumeRolePolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "codebuild.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};

// --- GitLab CI config ---

export const nodeImage = new _.gl.Image({ name: "node:20-alpine" });

export const npmCache = new _.gl.Cache({
  key: "$CI_COMMIT_REF_SLUG",
  paths: ["node_modules/"],
  policy: "pull-push",
});

export const buildArtifacts = new _.gl.Artifacts({
  paths: ["dist/"],
  expireIn: "1 hour",
});

export const testArtifacts = new _.gl.Artifacts({
  paths: ["coverage/"],
  expireIn: "1 week",
  reports: { junit: "coverage/junit.xml" },
});

export const onDefaultBranch = new _.gl.Rule({
  ifCondition: `${_.gl.CI.CommitBranch} == ${_.gl.CI.DefaultBranch}`,
});
