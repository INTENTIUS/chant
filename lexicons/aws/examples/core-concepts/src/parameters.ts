import { Parameter, Bucket, Sub, Ref } from "@intentius/chant-lexicon-aws";

// Declare a CloudFormation parameter
export const environment = new Parameter("String", {
  description: "Deployment environment",
  defaultValue: "dev",
});

// Use the parameter in a resource name via Ref
export const envBucket = new Bucket({
  BucketName: Sub`${Ref(environment)}-app-data`,
});
