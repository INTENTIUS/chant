import * as _ from "./_";

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
