import { Role, ManagedPolicy, Sub, AWS } from "@intentius/chant-lexicon-aws";

export const functionRole = new Role({
  roleName: Sub`${AWS.StackName}-role`,
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

export const readPolicy = new ManagedPolicy({
  policyDocument: {
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:GetObject"],
        Resource: Sub`arn:aws:s3:::${AWS.StackName}-data/*`,
      },
    ],
  },
  roles: [functionRole],
});
