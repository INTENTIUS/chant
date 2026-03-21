import { Composite, mergeDefaults } from "@intentius/chant";
import {
  Bucket,
  Bucket_BucketEncryption,
  Bucket_ServerSideEncryptionRule,
  Bucket_ServerSideEncryptionByDefault,
  Bucket_PublicAccessBlockConfiguration,
  Bucket_NotificationConfiguration,
  Bucket_LambdaConfiguration,
  Permission,
  Role_Policy,
} from "../generated";
import { Sub, Join } from "../intrinsics";
import { S3Actions } from "../actions/s3";
import { LambdaFunction, type LambdaFunctionProps } from "./lambda-function";

export interface LambdaS3Props extends LambdaFunctionProps {
  bucketName?: string;
  access?: "ReadOnly" | "ReadWrite" | "Full";
  trigger?: {
    events?: string[];
    prefix?: string;
    suffix?: string;
  };
  defaults?: LambdaFunctionProps["defaults"] & {
    bucket?: Partial<ConstructorParameters<typeof Bucket>[0]>;
  };
}

export const LambdaS3 = Composite<LambdaS3Props>((props) => {
  const encryptionDefault = new Bucket_ServerSideEncryptionByDefault({ SSEAlgorithm: "AES256" });
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
  const access = props.access ?? "ReadWrite";

  if (props.trigger) {
    // Create Lambda first to break the circular CFN dependency.
    // Compute bucket ARN from name (no GetAtt on bucket → no resource dep).
    const name = props.bucketName ?? Sub`\${AWS::StackName}-bucket`;
    const bucketArnBase = Join("", ["arn:aws:s3:::", name]);
    const bucketArnWildcard = Join("", ["arn:aws:s3:::", name, "/*"]);

    const s3Policy = new Role_Policy({
      PolicyName: `S3${access}`,
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: S3Actions[access], Resource: [bucketArnBase, bucketArnWildcard] }],
      },
    });

    const policies = props.Policies ? [s3Policy, ...props.Policies] : [s3Policy];
    const env = props.Environment ?? { Variables: {} };
    const variables = { ...((env as any).Variables ?? {}), BUCKET_NAME: name };
    const { role, func } = LambdaFunction({ ...props, Policies: policies, Environment: { Variables: variables } });

    const permission = new Permission({
      FunctionName: func.Arn,
      Action: "lambda:InvokeFunction",
      Principal: "s3.amazonaws.com",
      SourceArn: bucketArnBase,
    });

    const { events = ["s3:ObjectCreated:*"], prefix, suffix } = props.trigger;
    const rules: Array<{ Name: string; Value: string }> = [];
    if (prefix) rules.push({ Name: "prefix", Value: prefix });
    if (suffix) rules.push({ Name: "suffix", Value: suffix });

    const lambdaConfigs = events.map((event) => new Bucket_LambdaConfiguration({
      Event: event,
      Function: func.Arn,
      ...(rules.length > 0 && { Filter: { S3Key: { Rules: rules } } }),
    }));

    const notificationConfig = new Bucket_NotificationConfiguration({
      LambdaConfigurations: lambdaConfigs,
    });

    const bucket = new Bucket(mergeDefaults({
      BucketName: props.bucketName,
      BucketEncryption: bucketEncryption,
      PublicAccessBlockConfiguration: publicAccessBlock,
      NotificationConfiguration: notificationConfig,
    }, defaults?.bucket), { DependsOn: [permission] });

    return { bucket, role, func, permission };
  }

  // Non-trigger path: original flow
  const bucket = new Bucket(mergeDefaults({
    BucketName: props.bucketName,
    BucketEncryption: bucketEncryption,
    PublicAccessBlockConfiguration: publicAccessBlock,
  }, defaults?.bucket));

  const s3PolicyDocument = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: S3Actions[access], Resource: [bucket.Arn, Sub`${bucket.Arn}/*`] }],
  };

  const s3Policy = new Role_Policy({ PolicyName: `S3${access}`, PolicyDocument: s3PolicyDocument });
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
