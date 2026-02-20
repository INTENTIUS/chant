import * as _ from "./_";

const defaultTags = [
  { key: "Team", value: "platform" },
  { key: "Environment", value: "production" },
];

export const taggedBucket = new _.Bucket({
  bucketName: "app-data",
  tags: defaultTags,
});
