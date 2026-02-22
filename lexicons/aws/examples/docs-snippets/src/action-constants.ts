import { Role, Role_Policy, Bucket, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { S3Actions } from "@intentius/chant-lexicon-aws";

const dataBucket = new Bucket({
  BucketName: Sub`${AWS.StackName}-data`,
});

export const readerRole = new Role({
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
  Policies: [
    new Role_Policy({
      PolicyName: "S3Read",
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: S3Actions.ReadOnly,
            Resource: dataBucket.Arn,
          },
        ],
      },
    }),
  ],
});
