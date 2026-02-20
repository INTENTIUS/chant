import * as _ from "./_";

export const functionRole = new _.Role({
  roleName: _.Sub`${_.AWS.StackName}-role`,
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
});

export const readPolicy = new _.ManagedPolicy({
  policyDocument: {
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:GetObject"],
        Resource: _.Sub`arn:aws:s3:::${_.AWS.StackName}-data/*`,
      },
    ],
  },
  roles: [_.$.functionRole],
});
