import { Bucket, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { versioningEnabled, bucketEncryption, publicAccessBlock } from "./defaults";
import { environment } from "./params";

export const dataBucket = new Bucket({
  BucketName: Sub`${AWS.StackName}-${Ref(environment)}-data`,
  VersioningConfiguration: versioningEnabled,
  BucketEncryption: bucketEncryption,
  PublicAccessBlockConfiguration: publicAccessBlock,
});
