import { Bucket, Sub, AWS, output } from "@intentius/chant-lexicon-aws";

const dataBucket = new Bucket({
  bucketName: Sub`${AWS.StackName}-data`,
});

export const dataBucketArn = output(dataBucket.arn, "DataBucketArn");
