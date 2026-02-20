import { Bucket } from "@intentius/chant-lexicon-aws";

export const bucket = new Bucket({
  bucketName: "my-bucket",
  tags: [
    { key: "Environment", value: "production" },
    { key: "Team", value: "platform" },
  ],
  bucketEncryption: {
    serverSideEncryptionConfiguration: [
      {
        serverSideEncryptionByDefault: { sseAlgorithm: "AES256" },
      },
    ],
  },
});
