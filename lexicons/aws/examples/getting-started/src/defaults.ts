import {
  ServerSideEncryptionByDefault,
  ServerSideEncryptionRule,
  BucketEncryption,
  PublicAccessBlockConfiguration,
  VersioningConfiguration,
} from "@intentius/chant-lexicon-aws";

export const encryptionDefault = new ServerSideEncryptionByDefault({
  SSEAlgorithm: "AES256",
});

export const encryptionRule = new ServerSideEncryptionRule({
  ServerSideEncryptionByDefault: encryptionDefault,
});

export const bucketEncryption = new BucketEncryption({
  ServerSideEncryptionConfiguration: [encryptionRule],
});

export const publicAccessBlock = new PublicAccessBlockConfiguration({
  BlockPublicAcls: true,
  BlockPublicPolicy: true,
  IgnorePublicAcls: true,
  RestrictPublicBuckets: true,
});

export const versioningEnabled = new VersioningConfiguration({
  Status: "Enabled",
});
