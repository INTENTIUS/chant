import { Bucket, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { versioningEnabled, bucketEncryption, publicAccessBlock } from "./defaults";

export const dataBucket = new Bucket({
  bucketName: Sub`${AWS.StackName}-${AWS.AccountId}-data`,
  versioningConfiguration: versioningEnabled,
  bucketEncryption: bucketEncryption,
  publicAccessBlockConfiguration: publicAccessBlock,
});
