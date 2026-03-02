import { Bucket, Sub, Ref } from "@intentius/chant-lexicon-aws";

export const paramRefBucket = new Bucket({
  BucketName: Sub`${Ref("Environment")}-data`,
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
});
