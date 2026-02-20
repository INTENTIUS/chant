import * as _ from "./_";

export const appBucket = new _.Bucket({
  bucketName: "my-app-data",
  versioningConfiguration: new _.VersioningConfiguration({
    status: "Enabled",
  }),
});
