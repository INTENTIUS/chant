import { Bucket, Sub, Ref } from "@intentius/chant-lexicon-aws";

export const bucket = new Bucket({
  BucketName: Sub`${Ref("Environment")}-data`,
});
