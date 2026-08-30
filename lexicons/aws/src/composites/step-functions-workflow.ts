import { Composite, mergeDefaults, type Value } from "@intentius/chant";
import {
  Role,
  Role_Policy,
  LogGroup,
  StateMachine,
  StateMachine_LoggingConfiguration,
  StateMachine_LogDestination,
  StateMachine_CloudWatchLogsLogGroup,
} from "../generated";
import { LambdaActions } from "../actions/lambda";

const stepFunctionsTrustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "states.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};

/**
 * CloudWatch Logs delivery actions a state machine's role needs to write to a
 * log group via `LoggingConfiguration`. These act on the account's log
 * delivery configuration rather than a specific ARN, so AWS documents them
 * granted with `Resource: "*"` — see
 * https://docs.aws.amazon.com/step-functions/latest/dg/cw-logs.html#cloudwatch-iam-policy
 */
const LOG_DELIVERY_ACTIONS = [
  "logs:CreateLogDelivery",
  "logs:GetLogDelivery",
  "logs:UpdateLogDelivery",
  "logs:DeleteLogDelivery",
  "logs:ListLogDeliveries",
  "logs:PutResourcePolicy",
  "logs:DescribeResourcePolicies",
  "logs:DescribeLogGroups",
];

const logDeliveryPolicyDocument = {
  Version: "2012-10-17" as const,
  // Log-delivery actions operate on the account's delivery configuration
  // rather than a specific ARN — AWS documents them with Resource: "*".
  Statement: [{ Effect: "Allow" as const, Action: LOG_DELIVERY_ACTIONS, Resource: "*" }],
};

export interface StepFunctionsWorkflowProps {
  /** `Value<string>`: a name is routinely built with `Sub`/`Ref` (#1366). */
  name?: Value<string>;
  /**
   * ASL state machine definition, authored as a plain object. Passed to
   * CloudFormation's `Definition` property rather than `DefinitionString`:
   * CFN accepts the definition as a native JSON value (verified against
   * Floci — both forms round-trip), so a task's `Resource` can carry a
   * `Ref`/`Fn::GetAtt` intrinsic — e.g. `Resource: someFunc.Arn` — directly,
   * with no `Fn::Sub` string templating needed to splice ARNs into a JSON
   * string. Same `Value<T>`-over-string-building bias as #1366, one level up.
   */
  definition: Record<string, unknown>;
  /** ARNs of the Lambda functions this workflow's tasks invoke; grants `lambda:InvokeFunction` on each. */
  lambdaFunctionArns?: Value<string>[];
  stateMachineType?: "STANDARD" | "EXPRESS";
  /** CloudWatch Logs retention for the auto-created log group. Default 14. */
  logRetentionDays?: number;
  /** `LoggingConfiguration` level. Default `"ALL"` — set `"OFF"` to skip execution logging. */
  loggingLevel?: "ALL" | "ERROR" | "FATAL" | "OFF";
  ManagedPolicyArns?: string[];
  Policies?: InstanceType<typeof Role_Policy>[];
  defaults?: {
    role?: Partial<ConstructorParameters<typeof Role>[0]>;
    logGroup?: Partial<ConstructorParameters<typeof LogGroup>[0]>;
    stateMachine?: Partial<ConstructorParameters<typeof StateMachine>[0]>;
  };
}

export const StepFunctionsWorkflow = Composite((props: StepFunctionsWorkflowProps) => {
  const { defaults } = props;

  const logGroup = new LogGroup(mergeDefaults({
    RetentionInDays: props.logRetentionDays ?? 14,
  }, defaults?.logGroup));

  const logDeliveryPolicy = new Role_Policy({
    PolicyName: "StepFunctionsLogDelivery",
    PolicyDocument: logDeliveryPolicyDocument,
  });

  const invokePolicyDocument = {
    Version: "2012-10-17" as const,
    Statement: [{ Effect: "Allow" as const, Action: LambdaActions.Invoke, Resource: props.lambdaFunctionArns }],
  };

  // Conditional entry via spread keeps the `new` out of the `if` (EVL002).
  const invokePolicies = props.lambdaFunctionArns && props.lambdaFunctionArns.length > 0
    ? [new Role_Policy({ PolicyName: "InvokeLambdaTasks", PolicyDocument: invokePolicyDocument })]
    : [];

  const policies = [logDeliveryPolicy, ...invokePolicies, ...(props.Policies ?? [])];

  const role = new Role(mergeDefaults({
    AssumeRolePolicyDocument: stepFunctionsTrustPolicy,
    ManagedPolicyArns: props.ManagedPolicyArns,
    Policies: policies,
  }, defaults?.role));

  const loggingConfiguration = new StateMachine_LoggingConfiguration({
    Destinations: [
      new StateMachine_LogDestination({
        CloudWatchLogsLogGroup: new StateMachine_CloudWatchLogsLogGroup({ LogGroupArn: logGroup.Arn }),
      }),
    ],
    IncludeExecutionData: true,
    Level: props.loggingLevel ?? "ALL",
  });

  const stateMachine = new StateMachine(mergeDefaults({
    StateMachineName: props.name,
    RoleArn: role.Arn,
    Definition: props.definition,
    StateMachineType: props.stateMachineType ?? "STANDARD",
    LoggingConfiguration: loggingConfiguration,
  }, defaults?.stateMachine));

  return { role, logGroup, stateMachine };
}, "StepFunctionsWorkflow");
