import { Bucket, Queue, Sub, AWS } from "@intentius/chant-lexicon-aws";

// The IaC: a tiny stack each environment gets one of, named for it by the component.
// Kept to S3 + SQS so it needs no IAM. The config below is what the AWS
// lexicon's semantic lint requires — block all public access on the bucket, a
// bucket policy denying plaintext requests, server-side encryption on the
// queue. The bucket name folds in the account id because S3 names are globally
// unique.
export const dataBucket = new Bucket({
  BucketName: Sub`${AWS.StackName}-${AWS.AccountId}-data`,
  Tags: [{ Key: "demo", Value: "trunk-curated-floci" }],
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
});

export const taskQueue = new Queue({
  QueueName: Sub`${AWS.StackName}-tasks`,
  Tags: [{ Key: "demo", Value: "trunk-curated-floci" }],
  SqsManagedSseEnabled: true,
});
