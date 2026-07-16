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

export type DynamoDBAccessLevel = keyof typeof DynamoDBActions;

// Map-backed lookup — avoids computed element access `DynamoDBActions[access]`
// that the evaluability lint (EVL003) flags despite the statically-typed key (#952).
const DYNAMODB_ACTIONS = new Map<DynamoDBAccessLevel, readonly string[]>(
  Object.entries(DynamoDBActions) as [DynamoDBAccessLevel, readonly string[]][],
);
export function dynamoDBActionsFor(access: DynamoDBAccessLevel): readonly string[] {
  return DYNAMODB_ACTIONS.get(access) ?? [];
}
