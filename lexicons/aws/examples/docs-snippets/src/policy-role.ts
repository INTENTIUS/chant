import { Role, ManagedPolicy } from "@intentius/chant-lexicon-aws";
import { lambdaTrustPolicy, s3ReadPolicy } from "./policy-trust";

export const functionRole = new Role({
  assumeRolePolicyDocument: lambdaTrustPolicy,
});

export const readPolicy = new ManagedPolicy({
  policyDocument: s3ReadPolicy,
  roles: [functionRole],
});
