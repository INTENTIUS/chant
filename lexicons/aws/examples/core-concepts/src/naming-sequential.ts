import { Bucket } from "@intentius/chant-lexicon-aws";

const envs = ["dev", "staging", "prod"] as const;

const buckets = envs.map(
  (env) =>
    new Bucket({
      BucketName: `myapp-${env}-data`,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    })
);

export const [devData, stagingData, prodData] = buckets;
