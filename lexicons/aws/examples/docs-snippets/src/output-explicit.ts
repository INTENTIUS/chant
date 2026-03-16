import { Bucket, Sub, AWS, output } from "@intentius/chant-lexicon-aws";

export const dataBucket = new Bucket({
  BucketName: Sub`${AWS.StackName}-data`,
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
});

export const dataBucketArn = output(dataBucket.Arn, "DataBucketArn");
