import { Sub, AWS, Bucket } from "@intentius/chant-lexicon-aws";
import { bucketEncryption } from "./defaults";

export const outputBucket = new Bucket({
  BucketName: Sub`${AWS.StackName}-output`,
  BucketEncryption: bucketEncryption,
});
