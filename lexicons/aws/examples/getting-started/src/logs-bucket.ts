import * as _ from "./_";

export const logsBucket = new _.Bucket({
  bucketName: _.Sub`${_.AWS.StackName}-logs`,
  accessControl: "LogDeliveryWrite",
  versioningConfiguration: _.$.versioningEnabled,
  bucketEncryption: _.$.bucketEncryption,
  publicAccessBlockConfiguration: _.$.publicAccessBlock,
});
