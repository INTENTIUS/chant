import { Bucket } from "@intentius/chant-lexicon-aws";

const defaultTags = [
  { key: "Team", value: "platform" },
  { key: "Environment", value: "production" },
];

export const taggedBucket = new Bucket({
  bucketName: "app-data",
  tags: defaultTags,
});
