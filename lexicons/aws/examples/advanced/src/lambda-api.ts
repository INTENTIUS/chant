import * as _ from "./_";

export interface LambdaApiProps {
  name: string | ReturnType<typeof _.Sub>;
  runtime: string;
  handler: string;
  code: InstanceType<typeof _.Code> | { zipFile: string };
  timeout?: number;
  memorySize?: number;
  environment?: InstanceType<typeof _.Environment> | { variables: Record<string, unknown> };
  policies?: InstanceType<typeof _.Role_Policy>[];
}

export const LambdaApi = _.Composite<LambdaApiProps>((props) => {
  const role = new _.Role({
    assumeRolePolicyDocument: _.$.lambdaTrustPolicy,
    managedPolicyArns: [_.$.lambdaBasicExecutionArn],
    policies: props.policies,
  });

  const func = new _.Function({
    functionName: props.name,
    runtime: props.runtime,
    handler: props.handler,
    code: props.code,
    role: role.arn,
    timeout: props.timeout,
    memorySize: props.memorySize,
    environment: props.environment,
  });

  const permission = new _.Permission({
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
