/**
 * Lambda execution role — IAM role with read-only S3 access to the data bucket.
 *
 * - Trusts lambda.amazonaws.com (from shared defaults)
 * - Attaches AWSLambdaBasicExecutionRole for CloudWatch Logs
 * - Inline policy grants s3:GetObject + s3:ListBucket on the data bucket
 */
import { Role, Role_Policy, Sub, AWS, Ref, S3Actions } from "@intentius/chant-lexicon-aws";
import { assumeRolePolicy } from "./defaults";
import { dataBucket } from "./data-bucket";

export const s3ReadPolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: S3Actions.ReadOnly,
      Resource: [dataBucket.Arn, Sub`${dataBucket.Arn}/*`],
    },
  ],
};

export const s3ReadPolicy = new Role_Policy({
  PolicyName: "S3ReadAccess",
  PolicyDocument: s3ReadPolicyDocument,
});

export const functionRole = new Role({
  // chant-disable-next-line COR003
  RoleName: Sub`${AWS.AccountId}-${Ref("name")}-chant-role`,
  AssumeRolePolicyDocument: assumeRolePolicy,
  ManagedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
  Policies: [s3ReadPolicy],
});
