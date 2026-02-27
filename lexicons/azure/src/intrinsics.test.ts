import { describe, it, expect } from "bun:test";
import { ResourceId, Reference, Concat, ResourceGroup, Subscription, UniqueString, Format, If, ListKeys } from "./intrinsics";

describe("ResourceId", () => {
  it("serializes to ARM bracket expression", () => {
    const result = ResourceId("Microsoft.Storage/storageAccounts", "myStorage");
    expect(result.toJSON()).toBe("[resourceId('Microsoft.Storage/storageAccounts', 'myStorage')]");
  });

  it("supports multiple name segments", () => {
    const result = ResourceId("Microsoft.Sql/servers/databases", "myServer", "myDb");
    expect(result.toJSON()).toBe("[resourceId('Microsoft.Sql/servers/databases', 'myServer', 'myDb')]");
  });
});

describe("Reference", () => {
  it("serializes without apiVersion", () => {
    const result = Reference("myStorage");
    expect(result.toJSON()).toBe("[reference('myStorage')]");
  });

  it("serializes with apiVersion", () => {
    const result = Reference("myStorage", "2023-01-01");
    expect(result.toJSON()).toBe("[reference('myStorage', '2023-01-01')]");
  });
});

describe("Concat", () => {
  it("serializes string arguments", () => {
    const result = Concat("prefix-", "suffix");
    expect(result.toJSON()).toBe("[concat('prefix-', 'suffix')]");
  });
});

describe("ResourceGroup", () => {
  it("serializes to resourceGroup()", () => {
    const result = ResourceGroup();
    expect(result.toJSON()).toBe("[resourceGroup()]");
  });
});

describe("Subscription", () => {
  it("serializes to subscription()", () => {
    const result = Subscription();
    expect(result.toJSON()).toBe("[subscription()]");
  });
});

describe("UniqueString", () => {
  it("serializes arguments", () => {
    const result = UniqueString("seed1", "seed2");
    expect(result.toJSON()).toBe("[uniqueString('seed1', 'seed2')]");
  });
});

describe("Format", () => {
  it("serializes format string and arguments", () => {
    const result = Format("{0}-{1}", "prefix", "suffix");
    expect(result.toJSON()).toBe("[format('{0}-{1}', 'prefix', 'suffix')]");
  });
});

describe("If", () => {
  it("serializes conditional", () => {
    const result = If("isProd", "prodValue", "devValue");
    expect(result.toJSON()).toBe("[if('isProd', 'prodValue', 'devValue')]");
  });
});

describe("ListKeys", () => {
  it("serializes with resourceId and apiVersion", () => {
    const result = ListKeys("storageId", "2023-01-01");
    expect(result.toJSON()).toBe("[listKeys('storageId', '2023-01-01')]");
  });
});
