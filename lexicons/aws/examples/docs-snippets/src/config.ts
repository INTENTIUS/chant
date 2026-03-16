import { ServerSideEncryptionByDefault } from "@intentius/chant-lexicon-aws";

export const encryptionDefault = new ServerSideEncryptionByDefault({
  SSEAlgorithm: "AES256",
});
