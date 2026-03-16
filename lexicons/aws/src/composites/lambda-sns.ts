import { Composite, mergeDefaults } from "@intentius/chant";
import { Topic, Subscription, Permission } from "../generated";
import { LambdaFunction, type LambdaFunctionProps } from "./lambda-function";

export interface LambdaSnsProps extends LambdaFunctionProps {
  topicName?: string;
  defaults?: LambdaFunctionProps["defaults"] & {
    topic?: Partial<ConstructorParameters<typeof Topic>[0]>;
    subscription?: Partial<ConstructorParameters<typeof Subscription>[0]>;
    permission?: Partial<ConstructorParameters<typeof Permission>[0]>;
  };
}

export const LambdaSns = Composite<LambdaSnsProps>((props) => {
  const { defaults } = props;
  const { role, func } = LambdaFunction(props);

  const topic = new Topic(mergeDefaults({
    TopicName: props.topicName,
  }, defaults?.topic));

  const subscription = new Subscription(mergeDefaults({
    TopicArn: topic.TopicArn,
    Protocol: "lambda",
    Endpoint: func.Arn,
  }, defaults?.subscription));

  const permission = new Permission(mergeDefaults({
    FunctionName: func.Arn,
    Action: "lambda:InvokeFunction",
    Principal: "sns.amazonaws.com",
    SourceArn: topic.TopicArn,
  }, defaults?.permission));

  return { topic, role, func, subscription, permission };
}, "LambdaSns");
