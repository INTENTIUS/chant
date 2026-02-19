import * as _ from "./_";

export const encryptionDefault = new _.ServerSideEncryptionByDefault({
  sseAlgorithm: "AES256",
});

export const encryptionRule = new _.ServerSideEncryptionRule({
  serverSideEncryptionByDefault: encryptionDefault,
});

export const bucketEncryption = new _.BucketEncryption({
  serverSideEncryptionConfiguration: [encryptionRule],
});

export const publicAccessBlock = new _.PublicAccessBlockConfiguration({
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});

export const versioningEnabled = new _.VersioningConfiguration({
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
