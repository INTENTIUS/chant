import { Bucket, If, AWS } from "@intentius/chant-lexicon-aws";

export const conditionalBucket = new Bucket({
  BucketName: "my-bucket",
  AccelerateConfiguration: If(
    "EnableAcceleration",
    { AccelerationStatus: "Enabled" },
    AWS.NoValue,
  ),
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
