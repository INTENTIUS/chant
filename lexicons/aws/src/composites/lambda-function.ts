import { Composite, withDefaults } from "@intentius/chant";
import { Role, Function, Function_VpcConfig, Role_Policy } from "../generated";

const lambdaTrustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};

const BASIC_EXECUTION_ARN =
  "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
const VPC_ACCESS_ARN =
  "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole";

export interface LambdaFunctionProps {
  name: string;
  Runtime: string;
  Handler: string;
  Code: ConstructorParameters<typeof Function>[0]["Code"];
  Timeout?: number;
  MemorySize?: number;
  Environment?: ConstructorParameters<typeof Function>[0]["Environment"];
  ManagedPolicyArns?: string[];
  Policies?: InstanceType<typeof Role_Policy>[];
  VpcConfig?: ConstructorParameters<typeof Function_VpcConfig>[0];
}

export const LambdaFunction = Composite<LambdaFunctionProps>((props) => {
  const managedPolicies = [BASIC_EXECUTION_ARN];
  if (props.VpcConfig) {
    managedPolicies.push(VPC_ACCESS_ARN);
  }
  if (props.ManagedPolicyArns) {
    managedPolicies.push(...props.ManagedPolicyArns);
  }

  const role = new Role({
    AssumeRolePolicyDocument: lambdaTrustPolicy,
    ManagedPolicyArns: managedPolicies,
    Policies: props.Policies,
  });

  const func = new Function({
    FunctionName: props.name,
    Runtime: props.Runtime as any,
    Handler: props.Handler,
    Code: props.Code,
    Role: role.Arn,
    Timeout: props.Timeout ?? 30,
    MemorySize: props.MemorySize,
    Environment: props.Environment,
    VpcConfig: props.VpcConfig ? new Function_VpcConfig(props.VpcConfig) : undefined,
  });

  return { role, func };
}, "LambdaFunction");

export const LambdaNode = withDefaults(LambdaFunction, {
  Runtime: "nodejs20.x",
  Handler: "index.handler",
});

export const LambdaPython = withDefaults(LambdaFunction, {
  Runtime: "python3.12",
  Handler: "handler.handler",
});

/** @deprecated Use `LambdaNode` instead */
export const NodeLambda = LambdaNode;
/** @deprecated Use `LambdaPython` instead */
export const PythonLambda = LambdaPython;
