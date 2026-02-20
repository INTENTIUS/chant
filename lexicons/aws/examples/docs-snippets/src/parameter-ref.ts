import { Bucket, Sub, Ref } from "@intentius/chant-lexicon-aws";

export const bucket = new Bucket({
  bucketName: Sub`${Ref("Environment")}-data`,
});
