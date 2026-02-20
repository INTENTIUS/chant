import { Bucket, Sub, Ref } from "@intentius/chant-lexicon-aws";
import { environment } from "./parameter-declaration";

export const bucket = new Bucket({
  bucketName: Sub`${Ref(environment)}-data`,
});
