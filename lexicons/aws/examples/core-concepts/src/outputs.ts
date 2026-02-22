import { output } from "@intentius/chant-lexicon-aws";
import { appBucket } from "./resource-basic";

// Export a value from the stack as a CloudFormation output
export const bucketArn = output(appBucket.Arn, "AppBucketArn");
