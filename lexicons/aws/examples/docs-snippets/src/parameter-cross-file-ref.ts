import { Bucket, Sub, Ref } from "@intentius/chant-lexicon-aws";
import { environment } from "./parameter-declaration";

export const crossRefBucket = new Bucket({
  BucketName: Sub`${Ref(environment)}-data`,
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
});
