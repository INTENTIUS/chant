import * as _ from "./_";

export const deployBucket = new _.Bucket({
  bucketName: _.Sub`${_.AWS.StackName}-deploy`,
  versioningConfiguration: _.$.versioningEnabled,
  bucketEncryption: _.$.bucketEncryption,
  publicAccessBlockConfiguration: _.$.publicAccessBlock,
});

export const deployRole = new _.Role({
  roleName: _.Sub`${_.AWS.StackName}-deploy-role`,
  assumeRolePolicyDocument: _.$.assumeRolePolicy,
});
