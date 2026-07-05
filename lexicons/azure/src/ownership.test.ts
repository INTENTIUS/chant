import { describe, expect, test } from "vitest";
import { ownershipEntries } from "@intentius/chant/ownership";
import { AZURE_TAG_OWNERSHIP_KEYS } from "./ownership";

describe("AZURE_TAG_OWNERSHIP_KEYS", () => {
  test("uses Azure hyphen-form tag keys (no slash, which Azure forbids)", () => {
    expect(AZURE_TAG_OWNERSHIP_KEYS).toEqual({
      managedBy: "chant-managed-by",
      stack: "chant-stack",
      env: "chant-env",
    });
    expect(Object.values(AZURE_TAG_OWNERSHIP_KEYS).some((k) => k.includes("/"))).toBe(false);
  });

  test("stamps the hyphen keys via the core ownershipEntries helper", () => {
    const e = ownershipEntries(AZURE_TAG_OWNERSHIP_KEYS, { stack: "billing", env: "stg" });
    expect(e).toEqual({ "chant-managed-by": "chant", "chant-stack": "billing", "chant-env": "stg" });
  });
});
