import { Bucket, Queue } from "@intentius/chant-lexicon-aws";

const app = { name: "myapp", team: "platform" } as const;

export const dataBucket = new Bucket({
  BucketName: `${app.name}-data`,
  Tags: [{ Key: "Team", Value: app.team }],
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
});

export const taskQueue = new Queue({
  QueueName: `${app.name}-tasks`,
  Tags: [{ Key: "Team", Value: app.team }],
});
