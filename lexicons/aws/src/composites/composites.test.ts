import { describe, test, expect, beforeEach } from "bun:test";
import { expandComposite, CompositeRegistry, isCompositeInstance } from "@intentius/chant";
import { AttrRef } from "@intentius/chant/attrref";
import { LambdaFunction, LambdaNode, LambdaPython, NodeLambda, PythonLambda } from "./lambda-function";
import { LambdaApi } from "./lambda-api";
import { LambdaScheduled, ScheduledLambda } from "./scheduled-lambda";
import { LambdaSqs } from "./lambda-sqs";
import { LambdaEventBridge } from "./lambda-eventbridge";
import { LambdaDynamoDB } from "./lambda-dynamodb";
import { LambdaS3 } from "./lambda-s3";
import { LambdaSns } from "./lambda-sns";

const baseProps = {
  name: "TestFunc",
  Runtime: "nodejs20.x",
  Handler: "index.handler",
  Code: { ZipFile: "exports.handler = async () => ({statusCode:200})" },
};

describe("LambdaFunction", () => {
  test("returns role and func members", () => {
    const instance = LambdaFunction(baseProps);
    expect(instance.role).toBeDefined();
    expect(instance.func).toBeDefined();
    expect(Object.keys(instance.members)).toEqual(["role", "func"]);
  });

  test("func.Role references role.Arn via AttrRef", () => {
    const instance = LambdaFunction(baseProps);
    const funcProps = (instance.func as any).props;
    expect(funcProps.Role).toBeInstanceOf(AttrRef);
  });

  test("expandComposite produces correct logical names", () => {
    const instance = LambdaFunction(baseProps);
    const expanded = expandComposite("myLambda", instance);
    expect(expanded.has("myLambdaRole")).toBe(true);
    expect(expanded.has("myLambdaFunc")).toBe(true);
    expect(expanded.size).toBe(2);
  });

  test("default timeout is 30", () => {
    const instance = LambdaFunction(baseProps);
    const funcProps = (instance.func as any).props;
    expect(funcProps.Timeout).toBe(30);
  });

  test("VpcConfig auto-attaches VPCAccessExecutionRole", () => {
    const instance = LambdaFunction({
      ...baseProps,
      VpcConfig: { SubnetIds: ["subnet-1"], SecurityGroupIds: ["sg-1"] },
    });
    const roleProps = (instance.role as any).props;
    expect(roleProps.ManagedPolicyArns).toContain(
      "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
    );
  });

  test("without VpcConfig, no VPCAccessExecutionRole", () => {
    const instance = LambdaFunction(baseProps);
    const roleProps = (instance.role as any).props;
    expect(roleProps.ManagedPolicyArns).not.toContain(
      "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
    );
  });

  test("additional ManagedPolicyArns are appended", () => {
    const customArn = "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess";
    const instance = LambdaFunction({
      ...baseProps,
      ManagedPolicyArns: [customArn],
    });
    const roleProps = (instance.role as any).props;
    expect(roleProps.ManagedPolicyArns).toContain(customArn);
    expect(roleProps.ManagedPolicyArns).toContain(
      "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    );
  });
});

describe("LambdaNode / LambdaPython presets", () => {
  test("LambdaNode defaults Runtime and Handler", () => {
    const instance = LambdaNode({
      name: "TestNode",
      Code: { ZipFile: "exports.handler = async () => ({})" },
    });
    const funcProps = (instance.func as any).props;
    expect(funcProps.Runtime).toBe("nodejs20.x");
    expect(funcProps.Handler).toBe("index.handler");
  });

  test("LambdaPython defaults Runtime and Handler", () => {
    const instance = LambdaPython({
      name: "TestPython",
      Code: { ZipFile: "def handler(event, context): return {}" },
    });
    const funcProps = (instance.func as any).props;
    expect(funcProps.Runtime).toBe("python3.12");
    expect(funcProps.Handler).toBe("handler.handler");
  });

  test("preset defaults can be overridden", () => {
    const instance = LambdaNode({
      name: "TestOverride",
      Runtime: "nodejs18.x",
      Code: { ZipFile: "" },
    });
    const funcProps = (instance.func as any).props;
    expect(funcProps.Runtime).toBe("nodejs18.x");
  });

  test("deprecated aliases still work", () => {
    expect(NodeLambda).toBe(LambdaNode);
    expect(PythonLambda).toBe(LambdaPython);
  });
});

describe("LambdaApi", () => {
  test("returns role, func, and permission members", () => {
    const instance = LambdaApi(baseProps);
    expect(Object.keys(instance.members)).toEqual(["role", "func", "permission"]);
  });

  test("permission references func.Arn", () => {
    const instance = LambdaApi(baseProps);
    const permProps = (instance.permission as any).props;
    expect(permProps.FunctionName).toBeInstanceOf(AttrRef);
    expect(permProps.Principal).toBe("apigateway.amazonaws.com");
  });

  test("sourceArn is passed through", () => {
    const instance = LambdaApi({
      ...baseProps,
      sourceArn: "arn:aws:execute-api:us-east-1:123:api/*",
    });
    const permProps = (instance.permission as any).props;
    expect(permProps.SourceArn).toBe("arn:aws:execute-api:us-east-1:123:api/*");
  });

  test("expandComposite produces 3 entries", () => {
    const expanded = expandComposite("api", LambdaApi(baseProps));
    expect(expanded.size).toBe(3);
    expect(expanded.has("apiRole")).toBe(true);
    expect(expanded.has("apiFunc")).toBe(true);
    expect(expanded.has("apiPermission")).toBe(true);
  });
});

describe("LambdaScheduled", () => {
  const scheduledProps = { ...baseProps, schedule: "rate(5 minutes)" };

  test("returns role, func, rule, and permission members", () => {
    const instance = LambdaScheduled(scheduledProps);
    expect(Object.keys(instance.members)).toEqual(["role", "func", "rule", "permission"]);
  });

  test("rule has ScheduleExpression and targets func", () => {
    const instance = LambdaScheduled(scheduledProps);
    const ruleProps = (instance.rule as any).props;
    expect(ruleProps.ScheduleExpression).toBe("rate(5 minutes)");
    expect(ruleProps.State).toBe("ENABLED");
    expect(ruleProps.Targets).toHaveLength(1);
  });

  test("enabled: false sets State to DISABLED", () => {
    const instance = LambdaScheduled({ ...scheduledProps, enabled: false });
    const ruleProps = (instance.rule as any).props;
    expect(ruleProps.State).toBe("DISABLED");
  });

  test("permission principal is events.amazonaws.com", () => {
    const instance = LambdaScheduled(scheduledProps);
    const permProps = (instance.permission as any).props;
    expect(permProps.Principal).toBe("events.amazonaws.com");
  });

  test("expandComposite produces 4 entries", () => {
    const expanded = expandComposite("cron", LambdaScheduled(scheduledProps));
    expect(expanded.size).toBe(4);
    expect(expanded.has("cronRole")).toBe(true);
    expect(expanded.has("cronFunc")).toBe(true);
    expect(expanded.has("cronRule")).toBe(true);
    expect(expanded.has("cronPermission")).toBe(true);
  });

  test("deprecated ScheduledLambda alias still works", () => {
    expect(ScheduledLambda).toBe(LambdaScheduled);
  });
});

describe("LambdaSqs", () => {
  test("returns queue, role, func members", () => {
    const instance = LambdaSqs(baseProps);
    expect(Object.keys(instance.members)).toEqual(["queue", "role", "func"]);
  });

  test("expandComposite produces 4 entries (queue + role + func + eventSourceMapping)", () => {
    const expanded = expandComposite("worker", LambdaSqs(baseProps));
    expect(expanded.has("workerQueue")).toBe(true);
    expect(expanded.has("workerRole")).toBe(true);
    expect(expanded.has("workerFunc")).toBe(true);
  });
});

describe("LambdaEventBridge", () => {
  test("returns rule, role, func, permission members", () => {
    const instance = LambdaEventBridge({ ...baseProps, schedule: "rate(1 hour)" });
    expect(Object.keys(instance.members)).toEqual(["rule", "role", "func", "permission"]);
  });

  test("supports eventPattern", () => {
    const instance = LambdaEventBridge({
      ...baseProps,
      eventPattern: { source: ["aws.s3"] },
    });
    const ruleProps = (instance.rule as any).props;
    expect(ruleProps.EventPattern).toEqual({ source: ["aws.s3"] });
  });
});

describe("LambdaDynamoDB", () => {
  test("returns table, role, func members", () => {
    const instance = LambdaDynamoDB({ ...baseProps, partitionKey: "pk" });
    expect(Object.keys(instance.members)).toEqual(["table", "role", "func"]);
  });

  test("creates sort key when specified", () => {
    const instance = LambdaDynamoDB({ ...baseProps, partitionKey: "pk", sortKey: "sk" });
    const tableProps = (instance.table as any).props;
    expect(tableProps.AttributeDefinitions).toHaveLength(2);
    expect(tableProps.KeySchema).toHaveLength(2);
  });
});

describe("LambdaS3", () => {
  test("returns bucket, role, func members", () => {
    const instance = LambdaS3(baseProps);
    expect(Object.keys(instance.members)).toEqual(["bucket", "role", "func"]);
  });

  test("bucket has encryption and public access block", () => {
    const instance = LambdaS3(baseProps);
    const bucketProps = (instance.bucket as any).props;
    expect(bucketProps.BucketEncryption).toBeDefined();
    expect(bucketProps.PublicAccessBlockConfiguration).toBeDefined();
  });
});

describe("LambdaSns", () => {
  test("returns topic, role, func, subscription, permission members", () => {
    const instance = LambdaSns(baseProps);
    expect(Object.keys(instance.members)).toEqual(["topic", "role", "func", "subscription", "permission"]);
  });

  test("subscription uses lambda protocol", () => {
    const instance = LambdaSns(baseProps);
    const subProps = (instance.subscription as any).props;
    expect(subProps.Protocol).toBe("lambda");
  });

  test("permission principal is sns.amazonaws.com", () => {
    const instance = LambdaSns(baseProps);
    const permProps = (instance.permission as any).props;
    expect(permProps.Principal).toBe("sns.amazonaws.com");
  });
});
