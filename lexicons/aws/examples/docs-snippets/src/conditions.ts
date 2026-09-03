import { Bucket, Condition, Equals, If, Parameter, Ref, AWS } from "@intentius/chant-lexicon-aws";

// Declare the condition — lifted into the template's Conditions section
export const accelerationEnabled = new Parameter("String", { defaultValue: "false" });
export const EnableAcceleration = new Condition(Equals(Ref(accelerationEnabled), "true"));

export const conditionalBucket = new Bucket({
  BucketName: "my-bucket",
  AccelerateConfiguration: If(
    EnableAcceleration,
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
