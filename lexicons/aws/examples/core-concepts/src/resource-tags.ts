import { Bucket, defaultTags, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { environment } from "./parameters";

// defaultTags() automatically applies tags to every taggable resource
export const tags = defaultTags([
  { Key: "Team", Value: "platform" },
  { Key: "Environment", Value: "production" },
]);

// This bucket will receive the default tags at synthesis time
export const taggedBucket = new Bucket({
  BucketName: Sub`${AWS.StackName}-${Ref(environment)}-tagged`,
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
});
