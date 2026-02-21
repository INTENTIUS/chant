import { Bucket } from "@intentius/chant-lexicon-aws";

export const bucket = new Bucket({
  BucketName: "my-bucket",
  Tags: [
    { Key: "Environment", Value: "production" },
    { Key: "Team", Value: "platform" },
  ],
  BucketEncryption: {
    ServerSideEncryptionConfiguration: [
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
      },
    ],
  },
});
