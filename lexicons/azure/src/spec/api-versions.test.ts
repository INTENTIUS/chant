import { describe, it, expect } from "bun:test";
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
    const paths = [
      "schemas/2022-01-01/Microsoft.Storage.json",
      "schemas/2023-06-01/Microsoft.Storage.json",
      "schemas/2023-01-01/Microsoft.Compute.json",
    ];
    const result = latestVersionPerProvider(paths);
    expect(result.get("Microsoft.Storage")?.apiVersion).toBe("2023-06-01");
    expect(result.get("Microsoft.Compute")?.apiVersion).toBe("2023-01-01");
  });
});
