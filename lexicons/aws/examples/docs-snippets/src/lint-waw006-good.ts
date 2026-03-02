import { Bucket } from "@intentius/chant-lexicon-aws";

export const bucket = new Bucket({
  BucketName: "my-bucket",
  BucketEncryption: {
    ServerSideEncryptionConfiguration: [
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
      },
    ],
  },
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
});
