import * as _ from "./_";

export const encryptionDefault = new _.ServerSideEncryptionByDefault({
  sseAlgorithm: "AES256",
});

export const publicAccessBlock = new _.PublicAccessBlockConfiguration({
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});
