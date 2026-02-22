import { Composite } from "@intentius/chant";
import { EventRule, EventRule_Target, Permission } from "../generated";
import { LambdaFunction, type LambdaFunctionProps } from "./lambda-function";

export interface LambdaEventBridgeProps extends LambdaFunctionProps {
  ruleName?: string;
  schedule?: string;
  eventPattern?: Record<string, unknown>;
  enabled?: boolean;
}

export const LambdaEventBridge = Composite<LambdaEventBridgeProps>((props) => {
  const { role, func } = LambdaFunction(props);

  const rule = new EventRule({
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
  });

  const permission = new Permission({
    FunctionName: func.Arn,
    Action: "lambda:InvokeFunction",
    Principal: "events.amazonaws.com",
    SourceArn: rule.Arn,
  });

  return { rule, role, func, permission };
}, "LambdaEventBridge");
