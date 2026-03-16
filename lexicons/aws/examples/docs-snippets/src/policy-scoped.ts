import { Sub, AWS } from "@intentius/chant-lexicon-aws";

export const bucketWritePolicy = {
  Statement: [{
    Effect: "Allow",
    Action: ["s3:PutObject"],
    Resource: Sub`arn:aws:s3:::${AWS.StackName}-data/*`,
  }],
};
