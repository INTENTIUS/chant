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
        // chant-disable-next-line WAW009
        Resource: "*",
      },
    ],
  },
  roles: [_.$.functionRole],
});
