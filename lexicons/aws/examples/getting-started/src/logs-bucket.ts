import { Bucket, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { versioningEnabled, bucketEncryption, publicAccessBlock } from "./defaults";

export const logsBucket = new Bucket({
  bucketName: Sub`${AWS.StackName}-logs`,
  accessControl: "LogDeliveryWrite",
  versioningConfiguration: versioningEnabled,
  bucketEncryption: bucketEncryption,
  publicAccessBlockConfiguration: publicAccessBlock,
});
