import { Sub, AWS } from "@intentius/chant-lexicon-aws";
import { LambdaNode, LambdaApi, LambdaScheduled, S3Actions } from "@intentius/chant-lexicon-aws";
import { Role_Policy } from "@intentius/chant-lexicon-aws";

// LambdaNode: Role + Function with nodejs20.x defaults
export const worker = LambdaNode({
  name: Sub`${AWS.StackName}-worker`,
  Code: { ZipFile: `exports.handler = async () => ({ statusCode: 200 });` },
});

// LambdaApi: Role + Function + Permission for API Gateway
export const api = LambdaApi({
  name: Sub`${AWS.StackName}-api`,
  Runtime: "nodejs20.x",
  Handler: "index.handler",
  Code: { ZipFile: `exports.handler = async () => ({ statusCode: 200 });` },
  Timeout: 10,
  sourceArn: Sub`arn:aws:execute-api:${AWS.Region}:${AWS.AccountId}:*/prod/*`,
});

// LambdaScheduled: Role + Function + EventBridge Rule + Permission
export const cron = LambdaScheduled({
  name: Sub`${AWS.StackName}-cron`,
  Runtime: "python3.12",
  Handler: "handler.handler",
  Code: { ZipFile: `def handler(event, context): return {"statusCode": 200}` },
  schedule: "rate(5 minutes)",
});

// Composites accept extra IAM policies
export const reader = LambdaNode({
  name: Sub`${AWS.StackName}-reader`,
  Code: { ZipFile: `exports.handler = async () => ({});` },
  Policies: [
    new Role_Policy({
      PolicyName: "S3Read",
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: S3Actions.ReadOnly,
          Resource: "*",
        }],
      },
    }),
  ],
});
