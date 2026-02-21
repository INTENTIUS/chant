import { ManagedPolicy } from "@intentius/chant-lexicon-aws";
import { dataBucket } from "./cross-ref-storage";
import { accessRole } from "./cross-ref-policy";

export const barrelReadPolicy = new ManagedPolicy({
  PolicyDocument: {
    Statement: [{
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: dataBucket.Arn,
    }],
  },
  Roles: [accessRole],
});
