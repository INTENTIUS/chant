import { describe, expect, test } from "vitest";
import { ownershipEntries } from "@intentius/chant/ownership";
import { AWS_TAG_OWNERSHIP_KEYS } from "./ownership";

describe("AWS_TAG_OWNERSHIP_KEYS", () => {
  test("uses AWS colon-form tag keys", () => {
    expect(AWS_TAG_OWNERSHIP_KEYS).toEqual({
      managedBy: "chant:managed-by",
      stack: "chant:stack",
      env: "chant:env",
    });
  });

  test("stamps the colon keys via the core ownershipEntries helper", () => {
    const e = ownershipEntries(AWS_TAG_OWNERSHIP_KEYS, { stack: "billing", env: "prod" });
    expect(e).toEqual({ "chant:managed-by": "chant", "chant:stack": "billing", "chant:env": "prod" });
  });
});
