import { Composite, mergeDefaults } from "@intentius/chant";
import {
  Table,
  Table_AttributeDefinition,
  Table_KeySchema,
  Table_StreamSpecification,
  Role_Policy,
  EventSourceMapping,
} from "../generated";
import { DynamoDBActions } from "../actions/dynamodb";
import { LambdaFunction, type LambdaFunctionProps } from "./lambda-function";

export interface LambdaDynamoDBProps extends LambdaFunctionProps {
  tableName?: string;
  partitionKey: string;
  sortKey?: string;
  access?: "ReadOnly" | "ReadWrite" | "Full" | "None";
  streams?: {
    viewType?: "NEW_IMAGE" | "OLD_IMAGE" | "NEW_AND_OLD_IMAGES" | "KEYS_ONLY";
    batchSize?: number;
    startingPosition?: "TRIM_HORIZON" | "LATEST";
    bisectOnFunctionError?: boolean;
  };
  defaults?: LambdaFunctionProps["defaults"] & {
    table?: Partial<ConstructorParameters<typeof Table>[0]>;
    eventSourceMapping?: Partial<ConstructorParameters<typeof EventSourceMapping>[0]>;
  };
}

export const LambdaDynamoDB = Composite<LambdaDynamoDBProps>((props) => {
  // Conditional entries via spread keep the `new`s out of the `if` (EVL002).
  const attributeDefinitions = [
    new Table_AttributeDefinition({ AttributeName: props.partitionKey, AttributeType: "S" }),
    ...(props.sortKey ? [new Table_AttributeDefinition({ AttributeName: props.sortKey, AttributeType: "S" })] : []),
  ];
  const keySchema: InstanceType<typeof Table_KeySchema>[] = [
    new Table_KeySchema({ AttributeName: props.partitionKey, KeyType: "HASH" }),
    ...(props.sortKey ? [new Table_KeySchema({ AttributeName: props.sortKey, KeyType: "RANGE" })] : []),
  ];

  const { defaults } = props;

  const table = new Table(mergeDefaults({
    TableName: props.tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: attributeDefinitions,
    KeySchema: keySchema,
    ...(props.streams && {
      StreamSpecification: new Table_StreamSpecification({
        StreamViewType: props.streams.viewType ?? "NEW_AND_OLD_IMAGES",
      }),
    }),
  }, defaults?.table));

  const access = props.access ?? "ReadWrite";
  // Build the policy list with conditional spreads (no push-inside-if) (EVL002).
  const policies: InstanceType<typeof Role_Policy>[] = [
    ...(access !== "None"
      ? [new Role_Policy({
          PolicyName: `DynamoDB${access}`,
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Action: DynamoDBActions[access], Resource: table.Arn }],
          },
        })]
      : []),
    ...(props.streams
      ? [new Role_Policy({
          PolicyName: "DynamoDBStreamRead",
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow",
              Action: [
                "dynamodb:GetRecords",
                "dynamodb:GetShardIterator",
                "dynamodb:DescribeStream",
                "dynamodb:ListStreams",
              ],
              Resource: table.StreamArn,
            }],
          },
        })]
      : []),
    ...(props.Policies ?? []),
  ];

  const env = props.Environment ?? { Variables: {} };
  const variables = { ...((env as any).Variables ?? {}), TABLE_NAME: table.Ref };
  const { role, func } = LambdaFunction({
    ...props,
    Policies: policies,
    Environment: { Variables: variables },
  });

  const eventSourceMapping: InstanceType<typeof EventSourceMapping> | undefined = props.streams
    ? new EventSourceMapping(mergeDefaults({
        FunctionName: func.Arn,
        EventSourceArn: table.StreamArn,
        StartingPosition: props.streams.startingPosition ?? "TRIM_HORIZON",
        ...(props.streams.batchSize !== undefined && { BatchSize: props.streams.batchSize }),
        ...(props.streams.bisectOnFunctionError !== undefined && { BisectBatchOnFunctionError: props.streams.bisectOnFunctionError }),
      }, defaults?.eventSourceMapping))
    : undefined;

  return { table, role, func, ...(eventSourceMapping ? { eventSourceMapping } : {}) };
}, "LambdaDynamoDB");
