import * as _ from "./_";

export const functionRole = new _.Role({
  assumeRolePolicyDocument: _.$.lambdaTrustPolicy,
});

export const readPolicy = new _.ManagedPolicy({
  policyDocument: _.$.s3ReadPolicy,
  roles: [_.$.functionRole],
});
