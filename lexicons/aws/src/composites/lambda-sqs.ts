import { Composite } from "@intentius/chant";
import { Queue, EventSourceMapping, Role_Policy } from "../generated";
import { SQSActions } from "../actions/sqs";
import { LambdaFunction, type LambdaFunctionProps } from "./lambda-function";

export interface LambdaSqsProps extends LambdaFunctionProps {
  queueName?: string;
  batchSize?: number;
  maxBatchingWindow?: number;
}

export const LambdaSqs = Composite<LambdaSqsProps>((props) => {
  const queue = new Queue({
    QueueName: props.queueName,
  });

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

  new EventSourceMapping({
    EventSourceArn: queue.Arn,
    FunctionName: func.Arn,
    BatchSize: props.batchSize ?? 10,
    MaximumBatchingWindowInSeconds: props.maxBatchingWindow,
  });

  return { queue, role, func };
}, "LambdaSqs");
