import { Composite } from "@intentius/chant";
import { Table, Table_AttributeDefinition, Table_KeySchema, Role_Policy } from "../generated";
import { DynamoDBActions } from "../actions/dynamodb";
import { LambdaFunction, type LambdaFunctionProps } from "./lambda-function";

export interface LambdaDynamoDBProps extends LambdaFunctionProps {
  tableName?: string;
  partitionKey: string;
  sortKey?: string;
  access?: "ReadOnly" | "ReadWrite" | "Full";
}

export const LambdaDynamoDB = Composite<LambdaDynamoDBProps>((props) => {
  const attributeDefinitions = [
    new Table_AttributeDefinition({ AttributeName: props.partitionKey, AttributeType: "S" }),
  ];
  const keySchema: InstanceType<typeof Table_KeySchema>[] = [
    new Table_KeySchema({ AttributeName: props.partitionKey, KeyType: "HASH" }),
  ];

  if (props.sortKey) {
    attributeDefinitions.push(
      new Table_AttributeDefinition({ AttributeName: props.sortKey, AttributeType: "S" }),
    );
    keySchema.push(
      new Table_KeySchema({ AttributeName: props.sortKey, KeyType: "RANGE" }),
    );
  }

  const table = new Table({
    TableName: props.tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: attributeDefinitions,
    KeySchema: keySchema,
  });

  const access = props.access ?? "ReadWrite";
  const dynamoPolicyDocument = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: DynamoDBActions[access],
        Resource: table.Arn,
      },
    ],
  };

  const dynamoPolicy = new Role_Policy({
    PolicyName: `DynamoDB${access}`,
    PolicyDocument: dynamoPolicyDocument,
  });

  const policies = props.Policies ? [dynamoPolicy, ...props.Policies] : [dynamoPolicy];
  const env = props.Environment ?? { Variables: {} };
  const variables = { ...((env as any).Variables ?? {}), TABLE_NAME: table.Ref };
  const { role, func } = LambdaFunction({
    ...props,
    Policies: policies,
    Environment: { Variables: variables },
  });

  return { table, role, func };
}, "LambdaDynamoDB");
