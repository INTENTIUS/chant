import { Bucket, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { environment } from "./parameters";

export const dataBucket = new Bucket({
  BucketName: Sub`${AWS.StackName}-${Ref(environment)}-data`,
});
