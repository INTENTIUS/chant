import { Table, Sub, AWS } from "@intentius/chant-lexicon-aws";

// items table — pay-per-request, single "pk" partition key. The CDK side declares the
// identical table; both names derive from the stack so the pair stays account-agnostic.
export const itemsTable = new Table({
  TableName: Sub`${AWS.StackName}-items`,
  BillingMode: "PAY_PER_REQUEST",
  AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
  KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
});
