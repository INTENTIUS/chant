import {
  Table,
  Table_AttributeDefinition,
  Table_KeySchema,
  Sub,
  AWS,
} from "@intentius/chant-lexicon-aws";

export const dataTable = new Table({
  TableName: Sub`${AWS.StackName}-data`,
  BillingMode: "PAY_PER_REQUEST",
  AttributeDefinitions: [
    new Table_AttributeDefinition({ AttributeName: "pk", AttributeType: "S" }),
    new Table_AttributeDefinition({ AttributeName: "sk", AttributeType: "S" }),
  ],
  KeySchema: [
    new Table_KeySchema({ AttributeName: "pk", KeyType: "HASH" }),
    new Table_KeySchema({ AttributeName: "sk", KeyType: "RANGE" }),
  ],
});
