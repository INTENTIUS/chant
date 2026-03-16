import { Composite, mergeDefaults } from "@intentius/chant";
import { EventRule, EventRule_Target, Permission } from "../generated";
import { LambdaFunction, type LambdaFunctionProps } from "./lambda-function";

export interface LambdaEventBridgeProps extends LambdaFunctionProps {
  ruleName?: string;
  schedule?: string;
  eventPattern?: Record<string, unknown>;
  enabled?: boolean;
  defaults?: LambdaFunctionProps["defaults"] & {
    rule?: Partial<ConstructorParameters<typeof EventRule>[0]>;
    permission?: Partial<ConstructorParameters<typeof Permission>[0]>;
  };
}

export const LambdaEventBridge = Composite<LambdaEventBridgeProps>((props) => {
  const { defaults } = props;
  const { role, func } = LambdaFunction(props);

  const rule = new EventRule(mergeDefaults({
    Name: props.ruleName,
    ScheduleExpression: props.schedule,
    EventPattern: props.eventPattern,
    State: (props.enabled ?? true) ? "ENABLED" : "DISABLED",
    Targets: [
      new EventRule_Target({
        Arn: func.Arn,
        Id: "Target0",
      }),
    ],
  }, defaults?.rule));

  const permission = new Permission(mergeDefaults({
    FunctionName: func.Arn,
    Action: "lambda:InvokeFunction",
    Principal: "events.amazonaws.com",
    SourceArn: rule.Arn,
  }, defaults?.permission));

  return { rule, role, func, permission };
}, "LambdaEventBridge");
