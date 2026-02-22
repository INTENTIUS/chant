/**
 * Shared defaults — reusable config imported by resource files.
 *
 * - S3 AES-256 encryption + public access block
 * - Lambda assume-role trust policy
 * - `name` parameter for resource naming ({AccountId}-{name}-chant-<suffix>)
 */
import {
  ServerSideEncryptionByDefault,
  ServerSideEncryptionRule,
  BucketEncryption,
  PublicAccessBlockConfiguration,
  Parameter,
} from "@intentius/chant-lexicon-aws";

export const encryptionDefault = new ServerSideEncryptionByDefault({
  SSEAlgorithm: "AES256",
});

export const encryptionRule = new ServerSideEncryptionRule({
  ServerSideEncryptionByDefault: encryptionDefault,
});

export const bucketEncryption = new BucketEncryption({
  ServerSideEncryptionConfiguration: [encryptionRule],
});

export const publicAccessBlock = new PublicAccessBlockConfiguration({
  BlockPublicAcls: true,
  BlockPublicPolicy: true,
  IgnorePublicAcls: true,
  RestrictPublicBuckets: true,
});

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

export const name = new Parameter("String", {
  description: "Project name used in resource naming",
});
