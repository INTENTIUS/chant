import {
  ServerSideEncryptionByDefault,
  ServerSideEncryptionRule,
  BucketEncryption,
  PublicAccessBlockConfiguration,
  VersioningConfiguration,
} from "@intentius/chant-lexicon-aws";

export const encryptionDefault = new ServerSideEncryptionByDefault({
  sseAlgorithm: "AES256",
});

export const encryptionRule = new ServerSideEncryptionRule({
  serverSideEncryptionByDefault: encryptionDefault,
});

export const bucketEncryption = new BucketEncryption({
  serverSideEncryptionConfiguration: [encryptionRule],
});

export const publicAccessBlock = new PublicAccessBlockConfiguration({
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});

export const versioningEnabled = new VersioningConfiguration({
  status: "Enabled",
});
