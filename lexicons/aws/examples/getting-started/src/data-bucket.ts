/**
 * Data bucket — encrypted S3 bucket for storing application data.
 * Public access is blocked; encryption uses AES-256 from shared defaults.
 */
import { Bucket, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { bucketEncryption, publicAccessBlock } from "./defaults";

export const dataBucket = new Bucket({
  // chant-disable-next-line COR003
  BucketName: Sub`${AWS.AccountId}-${Ref("name")}-chant-data`,
  BucketEncryption: bucketEncryption,
  PublicAccessBlockConfiguration: publicAccessBlock,
});
