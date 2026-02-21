import { Bucket } from "@intentius/chant-lexicon-aws";

const defaultTags = [
  { Key: "Team", Value: "platform" },
  { Key: "Environment", Value: "production" },
];

export const taggedBucket = new Bucket({
  BucketName: "app-data",
  Tags: defaultTags,
});
