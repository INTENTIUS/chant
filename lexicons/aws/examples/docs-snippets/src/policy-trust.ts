import { Sub, AWS } from "@intentius/chant-lexicon-aws";

// Trust policy — allows Lambda service to assume this role
export const lambdaTrustPolicy = {
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Principal: { Service: "lambda.amazonaws.com" },
    Action: "sts:AssumeRole",
  }],
};

// Read-only S3 policy
export const s3ReadPolicy = {
  Statement: [{
    Effect: "Allow",
    Action: ["s3:GetObject", "s3:ListBucket"],
    Resource: Sub`arn:aws:s3:::${AWS.StackName}-data/*`,
  }],
};
