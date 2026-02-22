import { Bucket, VersioningConfiguration, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { environment } from "./parameters";

export const appBucket = new Bucket({
  BucketName: Sub`${AWS.StackName}-${Ref(environment)}-app-data`,
  VersioningConfiguration: new VersioningConfiguration({
    Status: "Enabled",
  }),
});
