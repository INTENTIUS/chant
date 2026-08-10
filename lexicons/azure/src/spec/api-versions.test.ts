import { describe, it, expect } from "vitest";
import { parseSchemaPath, latestVersionPerProvider, compareApiDates } from "./api-versions";

describe("parseSchemaPath", () => {
  it("parses a valid schema path", () => {
    const result = parseSchemaPath(
      "azure-resource-manager-schemas-main/schemas/2023-01-01/Microsoft.Storage.json",
    );
    expect(result).toEqual({
      provider: "Microsoft.Storage",
      apiVersion: "2023-01-01",
    });
  });

  it("parses a preview API version", () => {
    const result = parseSchemaPath(
      "azure-resource-manager-schemas-main/schemas/2023-06-01-preview/Microsoft.Compute.json",
    );
    expect(result).toEqual({
      provider: "Microsoft.Compute",
      apiVersion: "2023-06-01-preview",
    });
  });

  it("returns null for non-provider paths", () => {
    expect(parseSchemaPath("README.md")).toBeNull();
    expect(parseSchemaPath("schemas/common-types/v1/types.json")).toBeNull();
  });
});

describe("compareApiDates", () => {
  it("compares dates correctly", () => {
    expect(compareApiDates("2023-06-01", "2023-01-01")).toBeGreaterThan(0);
    expect(compareApiDates("2022-01-01", "2023-01-01")).toBeLessThan(0);
    expect(compareApiDates("2023-01-01", "2023-01-01")).toBe(0);
  });
});

describe("latestVersionPerProvider", () => {
  it("picks the latest API version per provider", () => {
    // Providers with no PROVIDER_VERSION_OVERRIDES entry — Microsoft.Compute
    // and Microsoft.Authorization are pinned (#1144, #223) and covered by
    // their own describe block below.
    const paths = [
      "schemas/2022-01-01/Microsoft.Storage.json",
      "schemas/2023-06-01/Microsoft.Storage.json",
      "schemas/2023-01-01/Microsoft.Network.json",
    ];
    const result = latestVersionPerProvider(paths);
    expect(result.get("Microsoft.Storage")?.map((f) => f.apiVersion)).toEqual(["2023-06-01"]);
    expect(result.get("Microsoft.Network")?.map((f) => f.apiVersion)).toEqual(["2023-01-01"]);
  });
});

describe("PROVIDER_VERSION_OVERRIDES", () => {
  it("pins Microsoft.Compute to the last date with the virtualMachines family (#1144)", () => {
    const paths = [
      "schemas/2025-11-01/Microsoft.Compute.json",
      "schemas/2026-03-01/Microsoft.Compute.json",
      "schemas/2026-03-02/Microsoft.Compute.json",
    ];
    const result = latestVersionPerProvider(paths);
    // 2026-03-02 is the naive "latest by date" but drops virtualMachines
    // (a disk-only delta); the override keeps 2026-03-01 instead.
    expect(result.get("Microsoft.Compute")?.map((f) => f.apiVersion)).toEqual(["2026-03-01"]);
  });

  it("keeps every pinned Microsoft.Authorization file, in pin order (#1545)", () => {
    // Shuffled on purpose — the result must follow the pin order (roles
    // first, then the policy file, then policyExemptions), not path order.
    const paths = [
      "schemas/2026-06-01/Microsoft.Authorization.json",
      "schemas/2022-07-01-preview/Microsoft.Authorization.json",
      "schemas/2025-01-01/Microsoft.Authorization.json",
      "schemas/2022-04-01/Microsoft.Authorization.json",
    ];
    const result = latestVersionPerProvider(paths);
    expect(result.get("Microsoft.Authorization")?.map((f) => f.apiVersion)).toEqual([
      "2022-04-01",
      "2026-06-01",
      "2022-07-01-preview",
    ]);
  });

  it("pins Microsoft.Management and Microsoft.Subscription to their latest GA dates (#1545)", () => {
    const paths = [
      "schemas/2023-04-01/Microsoft.Management.json",
      "schemas/2024-02-01-preview/Microsoft.Management.json",
      "schemas/2021-10-01/Microsoft.Subscription.json",
      "schemas/2025-11-01-preview/Microsoft.Subscription.json",
    ];
    const result = latestVersionPerProvider(paths);
    expect(result.get("Microsoft.Management")?.map((f) => f.apiVersion)).toEqual(["2023-04-01"]);
    expect(result.get("Microsoft.Subscription")?.map((f) => f.apiVersion)).toEqual(["2021-10-01"]);
  });
});
