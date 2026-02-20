import { ServerSideEncryptionByDefault, PublicAccessBlockConfiguration } from "@intentius/chant-lexicon-aws";

export const encryptionDefault = new ServerSideEncryptionByDefault({
  sseAlgorithm: "AES256",
});

export const publicAccessBlock = new PublicAccessBlockConfiguration({
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});
