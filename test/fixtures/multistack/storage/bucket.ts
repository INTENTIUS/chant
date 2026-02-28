import { Bucket, PublicAccessBlockConfiguration, Tag } from "@intentius/chant-lexicon-aws";
export const dataBucket = new Bucket({
  BucketName: "multi-stack-data",
  PublicAccessBlockConfiguration: new PublicAccessBlockConfiguration({
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  }),
  Tags: [new Tag({ Key: "Name", Value: "data-bucket" })],
});
