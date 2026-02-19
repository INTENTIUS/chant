import { describe, test, expect } from "bun:test";
import { CFParser } from "./parser";
import { CFGenerator } from "./generator";

describe("CloudFormation round-trip", () => {
  const parser = new CFParser();
  const generator = new CFGenerator();

  test("round-trips simple S3 bucket", () => {
    const original = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: "my-bucket",
          },
        },
      },
    };

    const content = JSON.stringify(original);
    const ir = parser.parse(content);
    const files = generator.generate(ir);

    expect(files[0].content).toContain("Bucket");
    expect(files[0].content).toContain('bucketName: "my-bucket"');
  });

  test("round-trips template with parameters", () => {
    const original = {
      AWSTemplateFormatVersion: "2010-09-09",
      Parameters: {
        Environment: {
          Type: "String",
          Default: "dev",
        },
      },
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: { Ref: "Environment" },
          },
        },
      },
    };

    const content = JSON.stringify(original);
    const ir = parser.parse(content);
    const files = generator.generate(ir);

    expect(files[0].content).toContain("Parameter");
    expect(files[0].content).toContain("environment");
    expect(files[0].content).toContain("bucketName: environment");
  });

  test("round-trips template with Fn::Sub", () => {
    const original = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: { "Fn::Sub": "${AWS::StackName}-data" },
          },
        },
      },
    };

    const content = JSON.stringify(original);
    const ir = parser.parse(content);
    const files = generator.generate(ir);

    expect(files[0].content).toContain("Sub");
    expect(files[0].content).toContain("AWS.StackName");
  });

  test("round-trips Lambda with IAM Role", () => {
    const original = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        LambdaRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            RoleName: "lambda-role",
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "lambda.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            },
          },
        },
        MyFunction: {
          Type: "AWS::Lambda::Function",
          Properties: {
            FunctionName: "my-function",
            Runtime: "nodejs18.x",
            Handler: "index.handler",
            Role: { "Fn::GetAtt": ["LambdaRole", "Arn"] },
          },
        },
      },
    };

    const content = JSON.stringify(original);
    const ir = parser.parse(content);
    const files = generator.generate(ir);

    expect(files[0].content).toContain("Role");
    expect(files[0].content).toContain("Function");
    expect(files[0].content).toContain("lambdaRole.arn");
  });

  test("round-trips complex nested properties", () => {
    const original = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        MyFunction: {
          Type: "AWS::Lambda::Function",
          Properties: {
            FunctionName: "my-function",
            Runtime: "nodejs18.x",
            Handler: "index.handler",
            Environment: {
              Variables: {
                NODE_ENV: "production",
                LOG_LEVEL: "info",
              },
            },
            VpcConfig: {
              SecurityGroupIds: ["sg-12345"],
              SubnetIds: ["subnet-abc", "subnet-def"],
            },
          },
        },
      },
    };

    const content = JSON.stringify(original);
    const ir = parser.parse(content);
    const files = generator.generate(ir);

    expect(files[0].content).toContain("Function");
    expect(files[0].content).toContain("environment");
    expect(files[0].content).toContain("vpcConfig");
  });

  test("round-trips empty template", () => {
    const original = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {},
    };

    const content = JSON.stringify(original);
    const ir = parser.parse(content);
    const files = generator.generate(ir);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("main.ts");
  });

  test("handles multiple resource types", () => {
    const original = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: { BucketName: "bucket" },
        },
        MyQueue: {
          Type: "AWS::SQS::Queue",
          Properties: { QueueName: "queue" },
        },
        MyTopic: {
          Type: "AWS::SNS::Topic",
          Properties: { TopicName: "topic" },
        },
      },
    };

    const content = JSON.stringify(original);
    const ir = parser.parse(content);
    const files = generator.generate(ir);

    expect(files[0].content).toContain("Bucket");
    expect(files[0].content).toContain("Queue");
    expect(files[0].content).toContain("Topic");
  });
});
