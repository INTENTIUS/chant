import { Composite, mergeDefaults } from "@intentius/chant";
import { Queue, EventSourceMapping, Role_Policy } from "../generated";
import { SQSActions } from "../actions/sqs";
import { LambdaFunction, type LambdaFunctionProps } from "./lambda-function";

export interface LambdaSqsProps extends LambdaFunctionProps {
  queueName?: string;
  batchSize?: number;
  maxBatchingWindow?: number;
  defaults?: LambdaFunctionProps["defaults"] & {
    queue?: Partial<ConstructorParameters<typeof Queue>[0]>;
    eventSourceMapping?: Partial<ConstructorParameters<typeof EventSourceMapping>[0]>;
  };
}

export const LambdaSqs = Composite<LambdaSqsProps>((props) => {
  const { defaults } = props;

  const queue = new Queue(mergeDefaults({
    QueueName: props.queueName,
  }, defaults?.queue));

  const sqsPolicyDocument = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: SQSActions.ReceiveMessage,
        Resource: queue.Arn,
      },
    ],
  };

  const sqsPolicy = new Role_Policy({
    PolicyName: "SQSReceive",
    PolicyDocument: sqsPolicyDocument,
  });

  const policies = props.Policies ? [sqsPolicy, ...props.Policies] : [sqsPolicy];
  const { role, func } = LambdaFunction({ ...props, Policies: policies });

  const eventSourceMapping = new EventSourceMapping(mergeDefaults({
    EventSourceArn: queue.Arn,
    FunctionName: func.Arn,
    BatchSize: props.batchSize ?? 10,
    MaximumBatchingWindowInSeconds: props.maxBatchingWindow,
  }, defaults?.eventSourceMapping));

  return { queue, role, func, eventSourceMapping };
}, "LambdaSqs");
