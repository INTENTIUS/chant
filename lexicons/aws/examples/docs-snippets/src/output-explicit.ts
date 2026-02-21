import { Bucket, Sub, AWS, output } from "@intentius/chant-lexicon-aws";

const dataBucket = new Bucket({
  BucketName: Sub`${AWS.StackName}-data`,
});

export const dataBucketArn = output(dataBucket.Arn, "DataBucketArn");
