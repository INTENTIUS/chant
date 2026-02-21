import { Bucket, VersioningConfiguration } from "@intentius/chant-lexicon-aws";

export const appBucket = new Bucket({
  BucketName: "my-app-data",
  VersioningConfiguration: new VersioningConfiguration({
    Status: "Enabled",
  }),
});
