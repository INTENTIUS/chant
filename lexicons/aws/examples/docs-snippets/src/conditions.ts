import { Bucket, If, AWS } from "@intentius/chant-lexicon-aws";

export const bucket = new Bucket({
  bucketName: "my-bucket",
  accelerateConfiguration: If(
    "EnableAcceleration",
    { accelerationStatus: "Enabled" },
    AWS.NoValue,
  ),
  bucketEncryption: {
    serverSideEncryptionConfiguration: [
      {
        serverSideEncryptionByDefault: { sseAlgorithm: "AES256" },
      },
    ],
  },
});
