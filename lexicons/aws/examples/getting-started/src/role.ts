import { Role, Sub, AWS } from "@intentius/chant-lexicon-aws";

export const assumeRolePolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};

export const functionRole = new Role({
  roleName: Sub`${AWS.StackName}-function-role`,
  assumeRolePolicyDocument: assumeRolePolicy,
});
