import { Bucket, Sub, Ref } from "@intentius/chant-lexicon-aws";
import { environment } from "./parameter-declaration";

export const bucket = new Bucket({
  BucketName: Sub`${Ref(environment)}-data`,
});
