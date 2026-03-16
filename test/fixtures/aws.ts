import { Bucket, PublicAccessBlockConfiguration, Tag } from "@intentius/chant-lexicon-aws";
export const myBucket = new Bucket({
  BucketName: "my-test-bucket",
  PublicAccessBlockConfiguration: new PublicAccessBlockConfiguration({
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  }),
  Tags: [new Tag({ Key: "Environment", Value: "test" })],
});
