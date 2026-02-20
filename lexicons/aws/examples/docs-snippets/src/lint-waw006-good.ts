import { Bucket } from "@intentius/chant-lexicon-aws";

export const bucket = new Bucket({
  bucketName: "my-bucket",
  bucketEncryption: {
    serverSideEncryptionConfiguration: [
      {
        serverSideEncryptionByDefault: { sseAlgorithm: "AES256" },
      },
    ],
  },
});
