import * as _ from "./_";

export const bucket = new _.Bucket({
  bucketName: _.Sub`${_.Ref("Environment")}-data`,
});
