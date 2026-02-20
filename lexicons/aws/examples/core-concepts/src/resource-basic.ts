import { Bucket, VersioningConfiguration } from "@intentius/chant-lexicon-aws";

export const appBucket = new Bucket({
  bucketName: "my-app-data",
  versioningConfiguration: new VersioningConfiguration({
    status: "Enabled",
  }),
});
