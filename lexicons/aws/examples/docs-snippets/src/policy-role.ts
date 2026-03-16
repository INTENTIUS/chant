import { Role, ManagedPolicy } from "@intentius/chant-lexicon-aws";
import { lambdaTrustPolicy, s3ReadPolicy } from "./policy-trust";

export const functionRole = new Role({
  AssumeRolePolicyDocument: lambdaTrustPolicy,
});

export const readPolicy = new ManagedPolicy({
  PolicyDocument: s3ReadPolicy,
  Roles: [functionRole],
});
