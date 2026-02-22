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
import { VpcDefault } from "./vpc-default";
import { FargateAlb } from "./fargate-alb";

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

describe("VpcDefault", () => {
  test("returns 17 members", () => {
    const instance = VpcDefault({});
    expect(Object.keys(instance.members)).toHaveLength(17);
  });

  test("has all expected member names", () => {
    const instance = VpcDefault({});
    const names = Object.keys(instance.members);
    expect(names).toContain("vpc");
    expect(names).toContain("igw");
    expect(names).toContain("igwAttachment");
    expect(names).toContain("publicSubnet1");
    expect(names).toContain("publicSubnet2");
    expect(names).toContain("privateSubnet1");
    expect(names).toContain("privateSubnet2");
    expect(names).toContain("publicRouteTable");
    expect(names).toContain("publicRoute");
    expect(names).toContain("publicRta1");
    expect(names).toContain("publicRta2");
    expect(names).toContain("privateRouteTable");
    expect(names).toContain("privateRta1");
    expect(names).toContain("privateRta2");
    expect(names).toContain("natEip");
    expect(names).toContain("natGateway");
    expect(names).toContain("privateRoute");
  });

  test("VPC has DNS enabled", () => {
    const instance = VpcDefault({});
    const vpcProps = (instance.vpc as any).props;
    expect(vpcProps.EnableDnsSupport).toBe(true);
    expect(vpcProps.EnableDnsHostnames).toBe(true);
  });

  test("public subnets have MapPublicIpOnLaunch", () => {
    const instance = VpcDefault({});
    const pub1Props = (instance.publicSubnet1 as any).props;
    const pub2Props = (instance.publicSubnet2 as any).props;
    expect(pub1Props.MapPublicIpOnLaunch).toBe(true);
    expect(pub2Props.MapPublicIpOnLaunch).toBe(true);
  });

  test("vpc.VpcId is wired to subnets", () => {
    const instance = VpcDefault({});
    const sub1Props = (instance.publicSubnet1 as any).props;
    expect(sub1Props.VpcId).toBeInstanceOf(AttrRef);
  });

  test("NAT gateway is present", () => {
    const instance = VpcDefault({});
    expect(instance.natGateway).toBeDefined();
    expect(instance.natEip).toBeDefined();
  });

  test("expandComposite produces 17 entries", () => {
    const expanded = expandComposite("net", VpcDefault({}));
    expect(expanded.size).toBe(17);
    expect(expanded.has("netVpc")).toBe(true);
    expect(expanded.has("netIgw")).toBe(true);
    expect(expanded.has("netNatGateway")).toBe(true);
  });

  test("custom CIDR overrides defaults", () => {
    const instance = VpcDefault({ cidr: "172.16.0.0/16" });
    const vpcProps = (instance.vpc as any).props;
    expect(vpcProps.CidrBlock).toBe("172.16.0.0/16");
  });
});

describe("FargateAlb", () => {
  const fargateProps = {
    image: "nginx:latest",
    vpcId: "vpc-123",
    publicSubnetIds: ["subnet-pub1", "subnet-pub2"],
    privateSubnetIds: ["subnet-priv1", "subnet-priv2"],
  };

  test("returns 11 members", () => {
    const instance = FargateAlb(fargateProps);
    expect(Object.keys(instance.members)).toHaveLength(11);
  });

  test("has all expected member names", () => {
    const instance = FargateAlb(fargateProps);
    const names = Object.keys(instance.members);
    expect(names).toEqual([
      "cluster", "executionRole", "taskRole", "logGroup", "taskDef",
      "albSg", "taskSg", "alb", "targetGroup", "listener", "service",
    ]);
  });

  test("expandComposite produces correct logical names", () => {
    const expanded = expandComposite("web", FargateAlb(fargateProps));
    expect(expanded.has("webCluster")).toBe(true);
    expect(expanded.has("webExecutionRole")).toBe(true);
    expect(expanded.has("webTaskRole")).toBe(true);
    expect(expanded.has("webLogGroup")).toBe(true);
    expect(expanded.has("webTaskDef")).toBe(true);
    expect(expanded.has("webAlbSg")).toBe(true);
    expect(expanded.has("webTaskSg")).toBe(true);
    expect(expanded.has("webAlb")).toBe(true);
    expect(expanded.has("webTargetGroup")).toBe(true);
    expect(expanded.has("webListener")).toBe(true);
    expect(expanded.has("webService")).toBe(true);
  });

  test("execution role has ECR and Logs policies", () => {
    const instance = FargateAlb(fargateProps);
    const roleProps = (instance.executionRole as any).props;
    expect(roleProps.Policies).toHaveLength(1);
    const policyDoc = (roleProps.Policies[0] as any).props.PolicyDocument;
    expect(policyDoc.Statement).toHaveLength(2);
    expect(policyDoc.Statement[0].Action).toContain("ecr:GetAuthorizationToken");
    expect(policyDoc.Statement[1].Action).toContain("logs:CreateLogStream");
  });

  test("task role receives custom policies", () => {
    const { Role_Policy } = require("../generated");
    const customPolicy = new Role_Policy({
      PolicyName: "Custom",
      PolicyDocument: { Version: "2012-10-17", Statement: [] },
    });
    const instance = FargateAlb({ ...fargateProps, Policies: [customPolicy] });
    const roleProps = (instance.taskRole as any).props;
    expect(roleProps.Policies).toHaveLength(1);
  });

  test("task definition has awsvpc and FARGATE", () => {
    const instance = FargateAlb(fargateProps);
    const tdProps = (instance.taskDef as any).props;
    expect(tdProps.NetworkMode).toBe("awsvpc");
    expect(tdProps.RequiresCompatibilities).toEqual(["FARGATE"]);
  });

  test("ALB SG allows ingress on listener port", () => {
    const instance = FargateAlb(fargateProps);
    const sgProps = (instance.albSg as any).props;
    expect(sgProps.SecurityGroupIngress).toHaveLength(1);
    const ingress = (sgProps.SecurityGroupIngress[0] as any).props;
    expect(ingress.FromPort).toBe(80);
    expect(ingress.CidrIp).toBe("0.0.0.0/0");
  });

  test("task SG references ALB SG GroupId", () => {
    const instance = FargateAlb(fargateProps);
    const sgProps = (instance.taskSg as any).props;
    const ingress = (sgProps.SecurityGroupIngress[0] as any).props;
    expect(ingress.SourceSecurityGroupId).toBeInstanceOf(AttrRef);
  });

  test("default container port is 80", () => {
    const instance = FargateAlb(fargateProps);
    const tdProps = (instance.taskDef as any).props;
    const containerDef = (tdProps.ContainerDefinitions[0] as any).props;
    const portMapping = (containerDef.PortMappings[0] as any).props;
    expect(portMapping.ContainerPort).toBe(80);
  });

  test("default desired count is 2", () => {
    const instance = FargateAlb(fargateProps);
    const svcProps = (instance.service as any).props;
    expect(svcProps.DesiredCount).toBe(2);
  });

  test("custom listener port is applied", () => {
    const instance = FargateAlb({ ...fargateProps, listenerPort: 8080 });
    const sgProps = (instance.albSg as any).props;
    const ingress = (sgProps.SecurityGroupIngress[0] as any).props;
    expect(ingress.FromPort).toBe(8080);
    expect(ingress.ToPort).toBe(8080);
  });
});
