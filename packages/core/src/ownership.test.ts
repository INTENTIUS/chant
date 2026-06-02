import { describe, expect, test } from "vitest";
import {
  ownershipEntries,
  ownershipKeys,
  hasOwnershipMarker,
  readOwnership,
  OWNERSHIP_MANAGED_BY_VALUE,
} from "./ownership";
import { resolveOwnershipMarker } from "./config";

describe("ownershipEntries (#119)", () => {
  test("label channel carries managed-by + stack + env", () => {
    const e = ownershipEntries("label", { stack: "billing", env: "prod" });
    expect(e["app.kubernetes.io/managed-by"]).toBe("chant");
    expect(e["chant.intentius.io/stack"]).toBe("billing");
    expect(e["chant.intentius.io/env"]).toBe("prod");
  });

  test("aws-tag channel uses colon keys", () => {
    const e = ownershipEntries("aws-tag", { stack: "billing" });
    expect(e["chant:managed-by"]).toBe("chant");
    expect(e["chant:stack"]).toBe("billing");
    expect(e["chant:env"]).toBeUndefined(); // env omitted when not set
  });

  test("azure-tag channel uses hyphen keys (no slash, which Azure forbids)", () => {
    const e = ownershipEntries("azure-tag", { stack: "billing", env: "stg" });
    expect(e["chant-managed-by"]).toBe("chant");
    expect(e["chant-stack"]).toBe("billing");
    expect(e["chant-env"]).toBe("stg");
    expect(Object.keys(e).some((k) => k.includes("/"))).toBe(false);
  });

  test("carries stack identity, not just managed=true", () => {
    const a = ownershipEntries("label", { stack: "stack-a" });
    const b = ownershipEntries("label", { stack: "stack-b" });
    expect(a[ownershipKeys("label").stack]).not.toBe(b[ownershipKeys("label").stack]);
  });
});

describe("hasOwnershipMarker / readOwnership", () => {
  test("detects chant's marker even when co-stamped with other tools", () => {
    const tags = {
      "chant:managed-by": OWNERSHIP_MANAGED_BY_VALUE,
      "chant:stack": "billing",
      "team": "payments", // foreign co-stamp
    };
    expect(hasOwnershipMarker(tags, "aws-tag")).toBe(true);
  });

  test("absent marker → not owned", () => {
    expect(hasOwnershipMarker({ team: "payments" }, "aws-tag")).toBe(false);
    expect(hasOwnershipMarker(undefined, "label")).toBe(false);
  });

  test("readOwnership recovers stack/env from a marked resource", () => {
    const labels = ownershipEntries("label", { stack: "billing", env: "prod" });
    expect(readOwnership(labels, "label")).toEqual({ stack: "billing", env: "prod" });
  });

  test("readOwnership returns undefined when unmarked", () => {
    expect(readOwnership({ foo: "bar" }, "label")).toBeUndefined();
  });
});

describe("resolveOwnershipMarker (config opt-in)", () => {
  test("enabled when stack is set", () => {
    expect(resolveOwnershipMarker({ ownership: { stack: "billing", env: "prod" } })).toEqual({
      stack: "billing",
      env: "prod",
    });
  });

  test("off when no ownership config", () => {
    expect(resolveOwnershipMarker({})).toBeUndefined();
  });

  test("off when stack missing", () => {
    expect(resolveOwnershipMarker({ ownership: { env: "prod" } })).toBeUndefined();
  });

  test("off when explicitly disabled", () => {
    expect(resolveOwnershipMarker({ ownership: { stack: "billing", enabled: false } })).toBeUndefined();
  });
});
