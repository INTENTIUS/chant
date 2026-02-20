import * as _ from "./_";
import { dataBucket } from "./cross-ref-storage";

export const accessRole = new _.Role({
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    }],
  },
});

export const readPolicy = new _.ManagedPolicy({
  policyDocument: {
    Statement: [{
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: dataBucket.arn,
    }],
  },
  roles: [accessRole],
});
