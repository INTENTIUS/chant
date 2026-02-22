export const DynamoDBActions = {
  // Broad groups
  ReadOnly: [
    "dynamodb:GetItem",
    "dynamodb:BatchGetItem",
    "dynamodb:Query",
    "dynamodb:Scan",
    "dynamodb:DescribeTable",
    "dynamodb:ConditionCheckItem",
  ],
  WriteOnly: [
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
    "dynamodb:BatchWriteItem",
  ],
  ReadWrite: [
    "dynamodb:GetItem",
    "dynamodb:BatchGetItem",
    "dynamodb:Query",
    "dynamodb:Scan",
    "dynamodb:DescribeTable",
    "dynamodb:ConditionCheckItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
    "dynamodb:BatchWriteItem",
  ],
  Full: ["dynamodb:*"],

  // Operation-specific
  GetItem: ["dynamodb:GetItem", "dynamodb:BatchGetItem"],
  PutItem: ["dynamodb:PutItem", "dynamodb:BatchWriteItem"],
  Query: ["dynamodb:Query"],
  Scan: ["dynamodb:Scan"],
} as const;
