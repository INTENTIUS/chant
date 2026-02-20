import { ManagedPolicy } from "@intentius/chant-lexicon-aws";
import { dataBucket } from "./cross-ref-storage";
import { accessRole } from "./cross-ref-policy";

export const barrelReadPolicy = new ManagedPolicy({
  policyDocument: {
    Statement: [{
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: dataBucket.arn,
    }],
  },
  roles: [accessRole],
});
