import { Bucket, If, AWS } from "@intentius/chant-lexicon-aws";

export const bucket = new Bucket({
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
});
