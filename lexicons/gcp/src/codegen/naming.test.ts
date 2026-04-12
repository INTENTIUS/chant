import { describe, test, expect } from "vitest";
import { NamingStrategy } from "./naming";
import type { GcpParseResult } from "../spec/parse";

function makeResult(typeName: string): GcpParseResult {
  return {
    resource: {
      typeName,
      properties: [],
      attributes: [],
      deprecatedProperties: [],
    },
    propertyTypes: [],
    enums: [],
    gvk: { group: "", version: "v1beta1", kind: typeName.split("::").pop()! },
  };
}

describe("NamingStrategy", () => {
  test("resolves priority names", () => {
    const results = [
      makeResult("GCP::Compute::Instance"),
      makeResult("GCP::Storage::Bucket"),
      makeResult("GCP::Container::Cluster"),
    ];
    const naming = new NamingStrategy(results);

    expect(naming.resolve("GCP::Compute::Instance")).toBe("ComputeInstance");
    expect(naming.resolve("GCP::Storage::Bucket")).toBe("StorageBucket");
    expect(naming.resolve("GCP::Container::Cluster")).toBe("GKECluster");
  });

  test("provides aliases", () => {
    const results = [makeResult("GCP::Container::Cluster")];
    const naming = new NamingStrategy(results);

    const aliases = naming.aliases("GCP::Container::Cluster");
    expect(aliases).toContain("GKE");
  });

  test("resolves non-priority types by short name", () => {
    const results = [makeResult("GCP::Accesscontextmanager::AccessLevel")];
    const naming = new NamingStrategy(results);

    const name = naming.resolve("GCP::Accesscontextmanager::AccessLevel");
    expect(name).toBeDefined();
    expect(name!.length).toBeGreaterThan(0);
  });
});
