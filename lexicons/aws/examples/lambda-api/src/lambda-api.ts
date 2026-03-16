import { Role, Function, Permission, Code, Environment, Sub, Role_Policy } from "@intentius/chant-lexicon-aws";
import { Composite } from "@intentius/chant";
import { lambdaTrustPolicy, lambdaBasicExecutionArn } from "./defaults";

export interface LambdaApiProps {
  name: string | ReturnType<typeof Sub>;
  runtime: string;
  handler: string;
  code: InstanceType<typeof Code> | { ZipFile: string };
  timeout?: number;
  memorySize?: number;
  environment?: InstanceType<typeof Environment> | { Variables: Record<string, unknown> };
  policies?: InstanceType<typeof Role_Policy>[];
}

export const LambdaApi = Composite<LambdaApiProps>((props) => {
  const role = new Role({
    AssumeRolePolicyDocument: lambdaTrustPolicy,
    ManagedPolicyArns: [lambdaBasicExecutionArn],
    Policies: props.policies,
  });

  const func = new Function({
    FunctionName: props.name,
    Runtime: props.runtime,
    Handler: props.handler,
    Code: props.code,
    Role: role.Arn,
    Timeout: props.timeout,
    MemorySize: props.memorySize,
    Environment: props.environment,
  });

  const permission = new Permission({
    FunctionName: func.Arn,
    Action: "lambda:InvokeFunction",
    Principal: "apigateway.amazonaws.com",
  });

  return { role, func, permission };
}, "LambdaApi");

export function SecureApi(props: Partial<LambdaApiProps>) {
  return LambdaApi({
    name: props.name!,
    runtime: props.runtime ?? "nodejs20.x",
    handler: props.handler ?? "index.handler",
    code: props.code!,
    timeout: props.timeout ?? 10,
    memorySize: props.memorySize ?? 256,
    environment: props.environment,
    policies: props.policies,
  });
}

export function HighMemoryApi(props: Partial<LambdaApiProps>) {
  return LambdaApi({
    name: props.name!,
    runtime: props.runtime ?? "nodejs20.x",
    handler: props.handler ?? "index.handler",
    code: props.code!,
    timeout: props.timeout ?? 25,
    memorySize: props.memorySize ?? 1024,
    environment: props.environment,
    policies: props.policies,
  });
}
