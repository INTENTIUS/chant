import * as _ from "./_";

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

export const functionRole = new _.Role({
  roleName: _.Sub`${_.AWS.StackName}-function-role`,
  assumeRolePolicyDocument: assumeRolePolicy,
});
