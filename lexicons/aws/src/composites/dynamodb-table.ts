import { Composite, mergeDefaults, type Value } from "@intentius/chant";
import {
  Table,
  Table_AttributeDefinition,
  Table_KeySchema,
  Table_GlobalSecondaryIndex,
  Table_Projection,
  Table_ProvisionedThroughput,
  Table_StreamSpecification,
  Table_TimeToLiveSpecification,
} from "../generated";

export interface DynamoDBKey {
  name: string;
  type?: "S" | "N" | "B";
}

export interface DynamoDBCapacity {
  readCapacity: number;
  writeCapacity: number;
}

export interface DynamoDBGlobalSecondaryIndex {
  name: string;
  partitionKey: DynamoDBKey;
  sortKey?: DynamoDBKey;
  /** Defaults to "ALL" — projecting the whole item is the common case; narrow it deliberately. */
  projectionType?: "ALL" | "KEYS_ONLY" | "INCLUDE";
  /** Only meaningful with projectionType "INCLUDE". */
  nonKeyAttributes?: string[];
  /** PROVISIONED tables only. Falls back to the table's own capacity when a GSI doesn't need its own. */
  provisionedThroughput?: DynamoDBCapacity;
}

export interface DynamoDBTableProps {
  /** `Value<string>`: a name is routinely built with `Sub`/`Ref` (#1366). */
  tableName?: Value<string>;
  partitionKey: DynamoDBKey;
  sortKey?: DynamoDBKey;
  /** Defaults to "PAY_PER_REQUEST" — the recommended default for most workloads (matches LambdaDynamoDB). */
  billingMode?: "PAY_PER_REQUEST" | "PROVISIONED";
  /** Required when billingMode is "PROVISIONED"; ignored otherwise. Falls back to 5/5 (the DynamoDB console default) if omitted. */
  provisionedThroughput?: DynamoDBCapacity;
  globalSecondaryIndexes?: DynamoDBGlobalSecondaryIndex[];
  /** Attribute name that carries the expiry timestamp. Enables TimeToLiveSpecification when set. */
  ttlAttribute?: string;
  /** Enables StreamSpecification. `true` defaults to NEW_AND_OLD_IMAGES (the shape most stream consumers want). */
  stream?: boolean | { viewType?: "NEW_IMAGE" | "OLD_IMAGE" | "NEW_AND_OLD_IMAGES" | "KEYS_ONLY" };
  defaults?: {
    table?: Partial<ConstructorParameters<typeof Table>[0]>;
  };
}

const DEFAULT_CAPACITY: DynamoDBCapacity = { readCapacity: 5, writeCapacity: 5 };

function toProvisionedThroughput(capacity: DynamoDBCapacity): InstanceType<typeof Table_ProvisionedThroughput> {
  return new Table_ProvisionedThroughput({
    ReadCapacityUnits: capacity.readCapacity,
    WriteCapacityUnits: capacity.writeCapacity,
  });
}

function toKeySchema(partitionKey: DynamoDBKey, sortKey?: DynamoDBKey): InstanceType<typeof Table_KeySchema>[] {
  // Conditional entries via spread keep the `new`s out of the `if` (EVL002).
  return [
    new Table_KeySchema({ AttributeName: partitionKey.name, KeyType: "HASH" }),
    ...(sortKey ? [new Table_KeySchema({ AttributeName: sortKey.name, KeyType: "RANGE" })] : []),
  ];
}

export const DynamoDBTable = Composite((props: DynamoDBTableProps) => {
  const billingMode = props.billingMode ?? "PAY_PER_REQUEST";
  const { defaults } = props;

  // Every key attribute used anywhere (table keys + every GSI's keys) needs exactly
  // one AttributeDefinition. A Map dedupes by name so a GSI reusing the table's
  // partition key (a common pattern) doesn't produce a duplicate definition.
  const attributeTypes = new Map<string, "S" | "N" | "B">();
  attributeTypes.set(props.partitionKey.name, props.partitionKey.type ?? "S");
  if (props.sortKey) attributeTypes.set(props.sortKey.name, props.sortKey.type ?? "S");
  for (const gsi of props.globalSecondaryIndexes ?? []) {
    attributeTypes.set(gsi.partitionKey.name, gsi.partitionKey.type ?? "S");
    if (gsi.sortKey) attributeTypes.set(gsi.sortKey.name, gsi.sortKey.type ?? "S");
  }
  const attributeDefinitions = [...attributeTypes.entries()].map(
    ([AttributeName, AttributeType]) => new Table_AttributeDefinition({ AttributeName, AttributeType }),
  );

  const globalSecondaryIndexes = (props.globalSecondaryIndexes ?? []).map((gsi) => new Table_GlobalSecondaryIndex({
    IndexName: gsi.name,
    KeySchema: toKeySchema(gsi.partitionKey, gsi.sortKey),
    Projection: new Table_Projection({
      ProjectionType: gsi.projectionType ?? "ALL",
      ...(gsi.nonKeyAttributes ? { NonKeyAttributes: gsi.nonKeyAttributes } : {}),
    }),
    ...(billingMode === "PROVISIONED"
      ? { ProvisionedThroughput: toProvisionedThroughput(gsi.provisionedThroughput ?? props.provisionedThroughput ?? DEFAULT_CAPACITY) }
      : {}),
  }));

  const streamConfig = props.stream === true ? {} : props.stream || undefined;
  const ttlEnabled = props.ttlAttribute !== undefined;

  const table = new Table(mergeDefaults({
    TableName: props.tableName,
    BillingMode: billingMode,
    AttributeDefinitions: attributeDefinitions,
    KeySchema: toKeySchema(props.partitionKey, props.sortKey),
    ...(globalSecondaryIndexes.length > 0 ? { GlobalSecondaryIndexes: globalSecondaryIndexes } : {}),
    ...(billingMode === "PROVISIONED"
      ? { ProvisionedThroughput: toProvisionedThroughput(props.provisionedThroughput ?? DEFAULT_CAPACITY) }
      : {}),
    ...(streamConfig
      ? { StreamSpecification: new Table_StreamSpecification({ StreamViewType: streamConfig.viewType ?? "NEW_AND_OLD_IMAGES" }) }
      : {}),
    ...(ttlEnabled
      ? { TimeToLiveSpecification: new Table_TimeToLiveSpecification({ Enabled: true, AttributeName: props.ttlAttribute }) }
      : {}),
  }, defaults?.table));

  return { table };
}, "DynamoDBTable");
