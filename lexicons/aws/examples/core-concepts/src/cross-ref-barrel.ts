import * as _ from "./_";

export const barrelReadPolicy = new _.ManagedPolicy({
  policyDocument: {
    Statement: [{
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: _.$.dataBucket.arn,
    }],
  },
  roles: [_.$.accessRole],
});
