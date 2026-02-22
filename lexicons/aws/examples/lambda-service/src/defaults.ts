import {
  BucketEncryption,
  ServerSideEncryptionRule,
  ServerSideEncryptionByDefault,
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
