import { Bucket, defaultTags } from "@intentius/chant-lexicon-aws";

// defaultTags() automatically applies tags to every taggable resource
export const tags = defaultTags([
  { Key: "Team", Value: "platform" },
  { Key: "Environment", Value: "production" },
]);

// This bucket will receive the default tags at synthesis time
export const taggedBucket = new Bucket({
  BucketName: "app-data",
});
