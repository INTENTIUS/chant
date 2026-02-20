import { ServerSideEncryptionByDefault } from "@intentius/chant-lexicon-aws";

export const encryptionDefault = new ServerSideEncryptionByDefault({
  sseAlgorithm: "AES256",
});
