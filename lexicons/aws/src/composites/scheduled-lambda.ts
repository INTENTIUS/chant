import { Composite, mergeDefaults } from "@intentius/chant";
import { EventRule, EventRule_Target, Permission } from "../generated";
import { LambdaFunction, type LambdaFunctionProps } from "./lambda-function";

export interface ScheduledLambdaProps extends LambdaFunctionProps {
  ruleName?: string;
  schedule: string;
  enabled?: boolean;
  defaults?: LambdaFunctionProps["defaults"] & {
    rule?: Partial<ConstructorParameters<typeof EventRule>[0]>;
    permission?: Partial<ConstructorParameters<typeof Permission>[0]>;
  };
}

export const LambdaScheduled = Composite<ScheduledLambdaProps>((props) => {
  const { defaults } = props;
  const { role, func } = LambdaFunction(props);

  const rule = new EventRule(mergeDefaults({
    Name: props.ruleName,
    ScheduleExpression: props.schedule,
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

  return { role, func, rule, permission };
}, "LambdaScheduled");

/** @deprecated Use `LambdaScheduled` instead */
export const ScheduledLambda = LambdaScheduled;
