import { Bucket, Queue, Sub, AWS } from "@intentius/chant-lexicon-aws";

// The IaC: a tiny stack the component release model deploys end-to-end.
// Kept to S3 + SQS so it needs no IAM. The config below is what the AWS
// lexicon's semantic lint requires — block all public access on the bucket,
// server-side encryption on the queue. The bucket name folds in the account id
// because S3 names are globally unique.
const app = { name: "components-e2e" } as const;

export const dataBucket = new Bucket({
  BucketName: Sub`${AWS.StackName}-${AWS.AccountId}-data`,
  Tags: [{ Key: "demo", Value: "components-aws-e2e" }],
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
});

export const taskQueue = new Queue({
  QueueName: `${app.name}-tasks`,
  Tags: [{ Key: "demo", Value: "components-aws-e2e" }],
  SqsManagedSseEnabled: true,
});
