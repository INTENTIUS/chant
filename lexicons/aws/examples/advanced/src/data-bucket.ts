import * as _ from "./_";

export const dataBucket = new _.Bucket({
  bucketName: _.Sub`${_.AWS.StackName}-data`,
  versioningConfiguration: _.$.versioningEnabled,
  bucketEncryption: _.$.bucketEncryption,
  publicAccessBlockConfiguration: _.$.publicAccessBlock,
});
