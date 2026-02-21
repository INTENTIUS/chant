import { Bucket } from "@intentius/chant-lexicon-aws";

export const dataBucket = new Bucket({
  BucketName: "app-data",
});
