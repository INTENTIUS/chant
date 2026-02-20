import * as _ from "./_";

export const encryptionDefault = new _.ServerSideEncryptionByDefault({
  sseAlgorithm: "AES256",
});
