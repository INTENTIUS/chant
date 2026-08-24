import { describe, expect, test } from "vitest";
import { ownershipEntries } from "@intentius/chant/ownership";
import { AWS_TAG_OWNERSHIP_KEYS, OWNERSHIP_METADATA_KEY, ownershipStackTagsForBody } from "./ownership";

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

describe("ownershipStackTagsForBody (#1222)", () => {
  test("reads the flat tag map under Metadata[chant:ownership]", () => {
    const body = JSON.stringify({
      Metadata: { [OWNERSHIP_METADATA_KEY]: { "chant:managed-by": "chant", "chant:stack": "shop", "chant:env": "dev" } },
      Resources: {},
    });
    expect(ownershipStackTagsForBody(body)).toEqual({
      "chant:managed-by": "chant",
      "chant:stack": "shop",
      "chant:env": "dev",
    });
  });

  test("total on bad input: non-JSON, no Metadata, no marker, non-string values", () => {
    expect(ownershipStackTagsForBody("Resources:\n  B:\n")).toEqual({});
    expect(ownershipStackTagsForBody(JSON.stringify({ Resources: {} }))).toEqual({});
    expect(ownershipStackTagsForBody(JSON.stringify({ Metadata: {}, Resources: {} }))).toEqual({});
    expect(
      ownershipStackTagsForBody(JSON.stringify({ Metadata: { [OWNERSHIP_METADATA_KEY]: { a: 1, b: "x" } } })),
    ).toEqual({ b: "x" });
  });
});
