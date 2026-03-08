import { Composite, mergeDefaults } from "@intentius/chant";
import {
  Bucket,
  Bucket_BucketEncryption,
  Bucket_ServerSideEncryptionRule,
  Bucket_ServerSideEncryptionByDefault,
  Bucket_PublicAccessBlockConfiguration,
  Role_Policy,
} from "../generated";
import { Sub } from "../intrinsics";
import { S3Actions } from "../actions/s3";
import { LambdaFunction, type LambdaFunctionProps } from "./lambda-function";

export interface LambdaS3Props extends LambdaFunctionProps {
  bucketName?: string;
  access?: "ReadOnly" | "ReadWrite" | "Full";
  defaults?: LambdaFunctionProps["defaults"] & {
    bucket?: Partial<ConstructorParameters<typeof Bucket>[0]>;
  };
}

export const LambdaS3 = Composite<LambdaS3Props>((props) => {
  const encryptionDefault = new Bucket_ServerSideEncryptionByDefault({
    SSEAlgorithm: "AES256",
  });

  const encryptionRule = new Bucket_ServerSideEncryptionRule({
    ServerSideEncryptionByDefault: encryptionDefault,
  });

  const bucketEncryption = new Bucket_BucketEncryption({
    ServerSideEncryptionConfiguration: [encryptionRule],
  });

  const publicAccessBlock = new Bucket_PublicAccessBlockConfiguration({
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });

  const { defaults } = props;

  const bucket = new Bucket(mergeDefaults({
    BucketName: props.bucketName,
    BucketEncryption: bucketEncryption,
    PublicAccessBlockConfiguration: publicAccessBlock,
  }, defaults?.bucket));

  const access = props.access ?? "ReadWrite";
  const s3PolicyDocument = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: S3Actions[access],
        Resource: [bucket.Arn, Sub`${bucket.Arn}/*`],
      },
    ],
  };

  const s3Policy = new Role_Policy({
    PolicyName: `S3${access}`,
    PolicyDocument: s3PolicyDocument,
  });

  const policies = props.Policies ? [s3Policy, ...props.Policies] : [s3Policy];
  const env = props.Environment ?? { Variables: {} };
  const variables = { ...((env as any).Variables ?? {}), BUCKET_NAME: bucket.Ref };
  const { role, func } = LambdaFunction({
    ...props,
    Policies: policies,
    Environment: { Variables: variables },
  });

  return { bucket, role, func };
}, "LambdaS3");
