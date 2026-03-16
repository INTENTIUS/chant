import { Bucket } from "@intentius/chant-lexicon-aws";

// chant-disable-next-line WAW006
export const hardcodedBucket = new Bucket({
  BucketName: "my-bucket",
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
});
