import { Bucket } from "@intentius/chant-lexicon-aws";

export const protectedBucket = new Bucket(
  { BucketName: "critical-data" },
  { DeletionPolicy: "Retain" },
);
