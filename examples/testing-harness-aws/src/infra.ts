import { Bucket, Queue, Sub, AWS } from "@intentius/chant-lexicon-aws";

// The stack under test: S3 + SQS, small enough to need no IAM. Every physical
// name folds in the CloudFormation stack name — which the test harness sets to
// the per-run environment (`test-<suite>-<nonce>`) — so two suites deploying in
// parallel never collide on a globally- or account-unique name.
export const dataBucket = new Bucket({
  BucketName: Sub`${AWS.StackName}-${AWS.AccountId}-data`,
  Tags: [{ Key: "demo", Value: "testing-harness-aws" }],
  BucketEncryption: {
    ServerSideEncryptionConfiguration: [
      { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
    ],
  },
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
});

export const taskQueue = new Queue({
  QueueName: Sub`${AWS.StackName}-tasks`,
  Tags: [{ Key: "demo", Value: "testing-harness-aws" }],
  SqsManagedSseEnabled: true,
});
