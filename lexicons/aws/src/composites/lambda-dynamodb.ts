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
  const policies: InstanceType<typeof Role_Policy>[] = [];

  if (access !== "None") {
    policies.push(new Role_Policy({
      PolicyName: `DynamoDB${access}`,
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: DynamoDBActions[access], Resource: table.Arn }],
      },
    }));
  }

  if (props.streams) {
    policies.push(new Role_Policy({
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
    }));
  }

  if (props.Policies) {
    policies.push(...props.Policies);
  }

  const env = props.Environment ?? { Variables: {} };
  const variables = { ...((env as any).Variables ?? {}), TABLE_NAME: table.Ref };
  const { role, func } = LambdaFunction({
    ...props,
    Policies: policies,
    Environment: { Variables: variables },
  });

  let eventSourceMapping: InstanceType<typeof EventSourceMapping> | undefined;
  if (props.streams) {
    const { startingPosition = "TRIM_HORIZON", batchSize, bisectOnFunctionError } = props.streams;
    eventSourceMapping = new EventSourceMapping(mergeDefaults({
      FunctionName: func.Arn,
      EventSourceArn: table.StreamArn,
      StartingPosition: startingPosition,
      ...(batchSize !== undefined && { BatchSize: batchSize }),
      ...(bisectOnFunctionError !== undefined && { BisectBatchOnFunctionError: bisectOnFunctionError }),
    }, defaults?.eventSourceMapping));
  }

  return { table, role, func, ...(eventSourceMapping ? { eventSourceMapping } : {}) };
}, "LambdaDynamoDB");
