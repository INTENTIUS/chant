import { Role, Function, Permission, Code, Environment, Sub, Role_Policy } from "@intentius/chant-lexicon-aws";
import { Composite } from "@intentius/chant";
import { lambdaTrustPolicy, lambdaBasicExecutionArn } from "./defaults";

export interface LambdaApiProps {
  name: string | ReturnType<typeof Sub>;
  runtime: string;
  handler: string;
  code: InstanceType<typeof Code> | { zipFile: string };
  timeout?: number;
  memorySize?: number;
  environment?: InstanceType<typeof Environment> | { variables: Record<string, unknown> };
  policies?: InstanceType<typeof Role_Policy>[];
}

export const LambdaApi = Composite<LambdaApiProps>((props) => {
  const role = new Role({
    assumeRolePolicyDocument: lambdaTrustPolicy,
    managedPolicyArns: [lambdaBasicExecutionArn],
    policies: props.policies,
  });

  const func = new Function({
    functionName: props.name,
    runtime: props.runtime,
    handler: props.handler,
    code: props.code,
    role: role.arn,
    timeout: props.timeout,
    memorySize: props.memorySize,
    environment: props.environment,
  });

  const permission = new Permission({
    functionName: func.arn,
    action: "lambda:InvokeFunction",
    principal: "apigateway.amazonaws.com",
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
