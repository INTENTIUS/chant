import { Role, ManagedPolicy, Sub, AWS } from "@intentius/chant-lexicon-aws";

export const functionRole = new Role({
  RoleName: Sub`${AWS.StackName}-role`,
  AssumeRolePolicyDocument: {
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
  PolicyDocument: {
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:GetObject"],
        // chant-disable-next-line WAW009
        Resource: "*",
      },
    ],
  },
  Roles: [functionRole],
});
