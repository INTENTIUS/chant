import * as _ from "./_";

export const bucketWritePolicy = {
  Statement: [{
    Effect: "Allow",
    Action: ["s3:PutObject"],
    Resource: _.Sub`arn:aws:s3:::${_.AWS.StackName}-data/*`,
  }],
};
