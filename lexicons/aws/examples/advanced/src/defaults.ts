import {
  ServerSideEncryptionByDefault,
  ServerSideEncryptionRule,
  BucketEncryption,
  PublicAccessBlockConfiguration,
  VersioningConfiguration,
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

export const versioningEnabled = new VersioningConfiguration({
  Status: "Enabled",
});

export const lambdaTrustPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};

export const lambdaBasicExecutionArn =
  "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
