import { describe, test, expect, beforeEach } from "bun:test";
import { expandComposite, CompositeRegistry, isCompositeInstance } from "@intentius/chant";
import { AttrRef } from "@intentius/chant/attrref";
import { LambdaFunction, NodeLambda, PythonLambda } from "./lambda-function";
import { LambdaApi } from "./lambda-api";
import { ScheduledLambda } from "./scheduled-lambda";

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
    expect(expanded.has("myLambda_role")).toBe(true);
    expect(expanded.has("myLambda_func")).toBe(true);
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

describe("NodeLambda / PythonLambda presets", () => {
  test("NodeLambda defaults Runtime and Handler", () => {
    const instance = NodeLambda({
      name: "TestNode",
      Code: { ZipFile: "exports.handler = async () => ({})" },
    });
    const funcProps = (instance.func as any).props;
    expect(funcProps.Runtime).toBe("nodejs20.x");
    expect(funcProps.Handler).toBe("index.handler");
  });

  test("PythonLambda defaults Runtime and Handler", () => {
    const instance = PythonLambda({
      name: "TestPython",
      Code: { ZipFile: "def handler(event, context): return {}" },
    });
    const funcProps = (instance.func as any).props;
    expect(funcProps.Runtime).toBe("python3.12");
    expect(funcProps.Handler).toBe("handler.handler");
  });

  test("preset defaults can be overridden", () => {
    const instance = NodeLambda({
      name: "TestOverride",
      Runtime: "nodejs18.x",
      Code: { ZipFile: "" },
    });
    const funcProps = (instance.func as any).props;
    expect(funcProps.Runtime).toBe("nodejs18.x");
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
    expect(expanded.has("api_role")).toBe(true);
    expect(expanded.has("api_func")).toBe(true);
    expect(expanded.has("api_permission")).toBe(true);
  });
});

describe("ScheduledLambda", () => {
  const scheduledProps = { ...baseProps, schedule: "rate(5 minutes)" };

  test("returns role, func, rule, and permission members", () => {
    const instance = ScheduledLambda(scheduledProps);
    expect(Object.keys(instance.members)).toEqual(["role", "func", "rule", "permission"]);
  });

  test("rule has ScheduleExpression and targets func", () => {
    const instance = ScheduledLambda(scheduledProps);
    const ruleProps = (instance.rule as any).props;
    expect(ruleProps.ScheduleExpression).toBe("rate(5 minutes)");
    expect(ruleProps.State).toBe("ENABLED");
    expect(ruleProps.Targets).toHaveLength(1);
  });

  test("enabled: false sets State to DISABLED", () => {
    const instance = ScheduledLambda({ ...scheduledProps, enabled: false });
    const ruleProps = (instance.rule as any).props;
    expect(ruleProps.State).toBe("DISABLED");
  });

  test("permission principal is events.amazonaws.com", () => {
    const instance = ScheduledLambda(scheduledProps);
    const permProps = (instance.permission as any).props;
    expect(permProps.Principal).toBe("events.amazonaws.com");
  });

  test("expandComposite produces 4 entries", () => {
    const expanded = expandComposite("cron", ScheduledLambda(scheduledProps));
    expect(expanded.size).toBe(4);
    expect(expanded.has("cron_role")).toBe(true);
    expect(expanded.has("cron_func")).toBe(true);
    expect(expanded.has("cron_rule")).toBe(true);
    expect(expanded.has("cron_permission")).toBe(true);
  });
});
