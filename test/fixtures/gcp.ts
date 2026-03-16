import { StorageBucket } from "@intentius/chant-lexicon-gcp";
export const bucket = new StorageBucket({
  resourceID: "smoke-bucket",
  location: "US",
  uniformBucketLevelAccess: true,
});
