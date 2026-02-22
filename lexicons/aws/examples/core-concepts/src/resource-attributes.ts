import { Bucket, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { environment } from "./parameters";

export const protectedBucket = new Bucket(
  { BucketName: Sub`${AWS.StackName}-${Ref(environment)}-critical` },
  { DeletionPolicy: "Retain" },
);
