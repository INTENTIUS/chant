import { Composite } from "@intentius/chant";
import { EventRule, EventRule_Target, Permission } from "../generated";
import { LambdaFunction, type LambdaFunctionProps } from "./lambda-function";

export interface ScheduledLambdaProps extends LambdaFunctionProps {
  ruleName?: string;
  schedule: string;
  enabled?: boolean;
}

export const LambdaScheduled = Composite<ScheduledLambdaProps>((props) => {
  const { role, func } = LambdaFunction(props);

  const rule = new EventRule({
    Name: props.ruleName,
    ScheduleExpression: props.schedule,
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

  return { role, func, rule, permission };
}, "LambdaScheduled");

/** @deprecated Use `LambdaScheduled` instead */
export const ScheduledLambda = LambdaScheduled;
