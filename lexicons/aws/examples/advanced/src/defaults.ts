import {
  ServerSideEncryptionByDefault,
  ServerSideEncryptionRule,
  BucketEncryption,
  PublicAccessBlockConfiguration,
  VersioningConfiguration,
} from "@intentius/chant-lexicon-aws";

export const encryptionDefault = new ServerSideEncryptionByDefault({
  sseAlgorithm: "AES256",
});

export const encryptionRule = new ServerSideEncryptionRule({
  serverSideEncryptionByDefault: encryptionDefault,
});

export const bucketEncryption = new BucketEncryption({
  serverSideEncryptionConfiguration: [encryptionRule],
});

export const publicAccessBlock = new PublicAccessBlockConfiguration({
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});

export const versioningEnabled = new VersioningConfiguration({
  status: "Enabled",
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
