import { Composite } from "@intentius/chant";
import { Topic, Subscription, Permission } from "../generated";
import { LambdaFunction, type LambdaFunctionProps } from "./lambda-function";

export interface LambdaSnsProps extends LambdaFunctionProps {
  topicName?: string;
}

export const LambdaSns = Composite<LambdaSnsProps>((props) => {
  const { role, func } = LambdaFunction(props);

  const topic = new Topic({
    TopicName: props.topicName,
  });

  const subscription = new Subscription({
    TopicArn: topic.TopicArn,
    Protocol: "lambda",
    Endpoint: func.Arn,
  });

  const permission = new Permission({
    FunctionName: func.Arn,
    Action: "lambda:InvokeFunction",
    Principal: "sns.amazonaws.com",
    SourceArn: topic.TopicArn,
  });

  return { topic, role, func, subscription, permission };
}, "LambdaSns");
