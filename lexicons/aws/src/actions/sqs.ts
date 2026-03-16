export const SQSActions = {
  SendMessage: [
    "sqs:SendMessage",
    "sqs:GetQueueUrl",
    "sqs:GetQueueAttributes",
  ],
  ReceiveMessage: [
    "sqs:ReceiveMessage",
    "sqs:DeleteMessage",
    "sqs:ChangeMessageVisibility",
    "sqs:GetQueueUrl",
    "sqs:GetQueueAttributes",
  ],
  Full: ["sqs:*"],
} as const;
