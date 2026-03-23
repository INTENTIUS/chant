import { Composite, withDefaults, mergeDefaults } from "@intentius/chant";
import { Role, Function, Function_VpcConfig, Role_Policy } from "../generated";
import { Sub } from "../intrinsics";

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
  name: string | ReturnType<typeof Sub>;
  Runtime: string;
  Handler: string;
  Code: ConstructorParameters<typeof Function>[0]["Code"];
  Timeout?: number;
  MemorySize?: number;
  Environment?: ConstructorParameters<typeof Function>[0]["Environment"];
  ManagedPolicyArns?: string[];
  Policies?: InstanceType<typeof Role_Policy>[];
  VpcConfig?: ConstructorParameters<typeof Function_VpcConfig>[0];
  defaults?: {
    role?: Partial<ConstructorParameters<typeof Role>[0]>;
    func?: Partial<ConstructorParameters<typeof Function>[0]>;
  };
}

export const LambdaFunction = Composite<LambdaFunctionProps>((props) => {
  const { defaults } = props;
  const managedPolicies = [BASIC_EXECUTION_ARN];
  if (props.VpcConfig) {
    managedPolicies.push(VPC_ACCESS_ARN);
  }
  if (props.ManagedPolicyArns) {
    managedPolicies.push(...props.ManagedPolicyArns);
  }

  const role = new Role(mergeDefaults({
    AssumeRolePolicyDocument: lambdaTrustPolicy,
    ManagedPolicyArns: managedPolicies,
    Policies: props.Policies,
  }, defaults?.role));

  const func = new Function(mergeDefaults({
    FunctionName: props.name,
    Runtime: props.Runtime as any,
    Handler: props.Handler,
    Code: props.Code,
    Role: role.Arn,
    Timeout: props.Timeout ?? 30,
    MemorySize: props.MemorySize,
    Environment: props.Environment,
    VpcConfig: props.VpcConfig ? new Function_VpcConfig(props.VpcConfig) : undefined,
  }, defaults?.func));

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
