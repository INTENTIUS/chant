import { Role, ManagedPolicy } from "@intentius/chant-lexicon-aws";
import { dataBucket } from "./cross-ref-storage";

export const accessRole = new Role({
  AssumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    }],
  },
});

export const readPolicy = new ManagedPolicy({
  PolicyDocument: {
    Statement: [{
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: dataBucket.Arn,
    }],
  },
  Roles: [accessRole],
});
