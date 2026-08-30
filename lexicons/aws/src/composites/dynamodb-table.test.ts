import { describe, test, expect } from "vitest";
import { expandComposite } from "@intentius/chant";
import { DynamoDBTable } from "./dynamodb-table";

// Generated property-kind instances (Table_KeySchema, Table_Projection, ...) store
// their data on a non-enumerable `.props`, so `toEqual` against a plain object
// compares empty own-enumerable-property sets unless each instance is unwrapped
// first. `p` unwraps one instance; `ps` maps an array of them.
const p = (x: any) => x.props;
const ps = (xs: any[]) => xs.map(p);

describe("DynamoDBTable", () => {
  test("partition-key-only: PAY_PER_REQUEST by default, single member", () => {
    const instance = DynamoDBTable({ partitionKey: { name: "id" } });
    expect(Object.keys(instance.members)).toEqual(["table"]);
    const props = (instance.table as any).props;
    expect(props.BillingMode).toBe("PAY_PER_REQUEST");
    expect(ps(props.KeySchema)).toEqual([{ AttributeName: "id", KeyType: "HASH" }]);
    expect(ps(props.AttributeDefinitions)).toEqual([{ AttributeName: "id", AttributeType: "S" }]);
    expect(props.ProvisionedThroughput).toBeUndefined();
  });

  test("expandComposite produces the table's logical name", () => {
    const expanded = expandComposite("orders", DynamoDBTable({ partitionKey: { name: "id" } }));
    expect(expanded.has("ordersTable")).toBe(true);
    expect(expanded.size).toBe(1);
  });

  test("partition + sort key, non-default types", () => {
    const instance = DynamoDBTable({
      partitionKey: { name: "pk", type: "S" },
      sortKey: { name: "sk", type: "N" },
    });
    const props = (instance.table as any).props;
    expect(ps(props.KeySchema)).toEqual([
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ]);
    expect(ps(props.AttributeDefinitions)).toEqual([
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "N" },
    ]);
  });

  test("no GSIs: GlobalSecondaryIndexes is omitted, not an empty array", () => {
    const props = (DynamoDBTable({ partitionKey: { name: "id" } }).table as any).props;
    expect(props.GlobalSecondaryIndexes).toBeUndefined();
  });

  test("a GSI defaults to ALL projection and, on-demand billing, carries no throughput", () => {
    const instance = DynamoDBTable({
      partitionKey: { name: "pk" },
      globalSecondaryIndexes: [{ name: "byStatus", partitionKey: { name: "status" } }],
    });
    const props = (instance.table as any).props;
    expect(props.GlobalSecondaryIndexes).toHaveLength(1);
    const gsi = p(props.GlobalSecondaryIndexes[0]);
    expect(gsi.IndexName).toBe("byStatus");
    expect(ps(gsi.KeySchema)).toEqual([{ AttributeName: "status", KeyType: "HASH" }]);
    expect(p(gsi.Projection)).toEqual({ ProjectionType: "ALL" });
    expect(gsi.ProvisionedThroughput).toBeUndefined();
  });

  test("a GSI reusing the table's partition key does not duplicate its AttributeDefinition", () => {
    const instance = DynamoDBTable({
      partitionKey: { name: "pk" },
      sortKey: { name: "sk" },
      globalSecondaryIndexes: [{ name: "byPk", partitionKey: { name: "pk" }, sortKey: { name: "gsiSort" } }],
    });
    const props = (instance.table as any).props;
    const names = ps(props.AttributeDefinitions).map((a: any) => a.AttributeName);
    expect(names).toEqual(["pk", "sk", "gsiSort"]);
  });

  test("INCLUDE projection carries nonKeyAttributes through", () => {
    const instance = DynamoDBTable({
      partitionKey: { name: "pk" },
      globalSecondaryIndexes: [{
        name: "byStatus",
        partitionKey: { name: "status" },
        projectionType: "INCLUDE",
        nonKeyAttributes: ["total", "updatedAt"],
      }],
    });
    const gsi = p(((instance.table as any).props.GlobalSecondaryIndexes)[0]);
    expect(p(gsi.Projection)).toEqual({ ProjectionType: "INCLUDE", NonKeyAttributes: ["total", "updatedAt"] });
  });

  test("ttlAttribute enables TimeToLiveSpecification; omitted, no TTL block at all", () => {
    const withTtl = (DynamoDBTable({ partitionKey: { name: "id" }, ttlAttribute: "expiresAt" }).table as any).props;
    expect(p(withTtl.TimeToLiveSpecification)).toEqual({ Enabled: true, AttributeName: "expiresAt" });

    const withoutTtl = (DynamoDBTable({ partitionKey: { name: "id" } }).table as any).props;
    expect(withoutTtl.TimeToLiveSpecification).toBeUndefined();
  });

  test("stream: true defaults to NEW_AND_OLD_IMAGES", () => {
    const props = (DynamoDBTable({ partitionKey: { name: "id" }, stream: true }).table as any).props;
    expect(p(props.StreamSpecification)).toEqual({ StreamViewType: "NEW_AND_OLD_IMAGES" });
  });

  test("stream view type is overridable; omitted, no stream block at all", () => {
    const withView = (DynamoDBTable({
      partitionKey: { name: "id" },
      stream: { viewType: "KEYS_ONLY" },
    }).table as any).props;
    expect(p(withView.StreamSpecification)).toEqual({ StreamViewType: "KEYS_ONLY" });

    const withoutStream = (DynamoDBTable({ partitionKey: { name: "id" } }).table as any).props;
    expect(withoutStream.StreamSpecification).toBeUndefined();
  });

  test("PROVISIONED billing mode defaults capacity to 5/5 on both table and GSI", () => {
    const instance = DynamoDBTable({
      partitionKey: { name: "id" },
      billingMode: "PROVISIONED",
      globalSecondaryIndexes: [{ name: "byStatus", partitionKey: { name: "status" } }],
    });
    const props = (instance.table as any).props;
    expect(p(props.ProvisionedThroughput)).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 5 });
    const gsi = p(props.GlobalSecondaryIndexes[0]);
    expect(p(gsi.ProvisionedThroughput)).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 5 });
  });

  test("PROVISIONED billing mode: explicit table capacity flows to a GSI that doesn't set its own", () => {
    const instance = DynamoDBTable({
      partitionKey: { name: "id" },
      billingMode: "PROVISIONED",
      provisionedThroughput: { readCapacity: 20, writeCapacity: 10 },
      globalSecondaryIndexes: [
        { name: "inherits", partitionKey: { name: "status" } },
        { name: "overrides", partitionKey: { name: "kind" }, provisionedThroughput: { readCapacity: 1, writeCapacity: 1 } },
      ],
    });
    const props = (instance.table as any).props;
    expect(p(props.ProvisionedThroughput)).toEqual({ ReadCapacityUnits: 20, WriteCapacityUnits: 10 });
    const [inherits, overrides] = ps(props.GlobalSecondaryIndexes);
    expect(p(inherits.ProvisionedThroughput)).toEqual({ ReadCapacityUnits: 20, WriteCapacityUnits: 10 });
    expect(p(overrides.ProvisionedThroughput)).toEqual({ ReadCapacityUnits: 1, WriteCapacityUnits: 1 });
  });

  test("tableName is threaded through when given", () => {
    const props = (DynamoDBTable({ partitionKey: { name: "id" }, tableName: "orders-prod" }).table as any).props;
    expect(props.TableName).toBe("orders-prod");
  });

  test("defaults escape hatch reaches the table (e.g. deletion protection)", () => {
    const props = (DynamoDBTable({
      partitionKey: { name: "id" },
      defaults: { table: { DeletionProtectionEnabled: true } },
    }).table as any).props;
    expect(props.DeletionProtectionEnabled).toBe(true);
  });
});
