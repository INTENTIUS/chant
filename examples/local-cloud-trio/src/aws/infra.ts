import { Bucket } from "@intentius/chant-lexicon-aws";

// AWS object store — an S3 bucket. Synthesizes to a CloudFormation template,
// deployed to Floci (emulated AWS) via `nativeApply(cloudformation)`.
export const bucket = new Bucket({
  BucketName: "chant-trio-bucket",
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
});

