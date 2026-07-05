import { describe, expect, test } from "vitest";
import {
  ownershipEntries,
  hasOwnershipMarker,
  readOwnership,
  classifyOwnership,
  tagArrayToMap,
  LABEL_OWNERSHIP_KEYS,
  OWNERSHIP_MANAGED_BY_VALUE,
  type ChannelKeys,
} from "./ownership";
import { resolveOwnershipMarker } from "./config";

// A stand-in for a lexicon-provided convention (e.g. AWS's colon keys), to
// prove the core helpers are generic over any `ChannelKeys` — the per-provider
// conventions themselves live in their lexicons (aws/azure), not here.
const COLON_KEYS: ChannelKeys = { managedBy: "chant:managed-by", stack: "chant:stack", env: "chant:env" };

describe("ownershipEntries (#119)", () => {
  test("the default label keys carry managed-by + stack + env", () => {
    const e = ownershipEntries(LABEL_OWNERSHIP_KEYS, { stack: "billing", env: "prod" });
    expect(e["app.kubernetes.io/managed-by"]).toBe("chant");
    expect(e["chant.intentius.io/stack"]).toBe("billing");
    expect(e["chant.intentius.io/env"]).toBe("prod");
  });

  test("stamps whatever key names the provided ChannelKeys names, env omitted when unset", () => {
    const e = ownershipEntries(COLON_KEYS, { stack: "billing" });
    expect(e["chant:managed-by"]).toBe("chant");
    expect(e["chant:stack"]).toBe("billing");
    expect(e["chant:env"]).toBeUndefined(); // env omitted when not set
  });

  test("carries stack identity, not just managed=true", () => {
    const a = ownershipEntries(LABEL_OWNERSHIP_KEYS, { stack: "stack-a" });
    const b = ownershipEntries(LABEL_OWNERSHIP_KEYS, { stack: "stack-b" });
    expect(a[LABEL_OWNERSHIP_KEYS.stack]).not.toBe(b[LABEL_OWNERSHIP_KEYS.stack]);
  });
});

describe("hasOwnershipMarker / readOwnership", () => {
  test("detects chant's marker even when co-stamped with other tools", () => {
    const tags = {
      "chant:managed-by": OWNERSHIP_MANAGED_BY_VALUE,
      "chant:stack": "billing",
      "team": "payments", // foreign co-stamp
    };
    expect(hasOwnershipMarker(tags, COLON_KEYS)).toBe(true);
  });

  test("absent marker → not owned", () => {
    expect(hasOwnershipMarker({ team: "payments" }, COLON_KEYS)).toBe(false);
    expect(hasOwnershipMarker(undefined, LABEL_OWNERSHIP_KEYS)).toBe(false);
  });

  test("readOwnership recovers stack/env from a marked resource", () => {
    const labels = ownershipEntries(LABEL_OWNERSHIP_KEYS, { stack: "billing", env: "prod" });
    expect(readOwnership(labels, LABEL_OWNERSHIP_KEYS)).toEqual({ stack: "billing", env: "prod" });
  });

  test("readOwnership returns undefined when unmarked", () => {
    expect(readOwnership({ foo: "bar" }, LABEL_OWNERSHIP_KEYS)).toBeUndefined();
  });
});

describe("classifyOwnership / tagArrayToMap (#120)", () => {
  test("marker present → owned, absent → foreign", () => {
    expect(classifyOwnership({ "chant:managed-by": "chant" }, COLON_KEYS)).toBe("owned");
    expect(classifyOwnership({ team: "x" }, COLON_KEYS)).toBe("foreign");
    expect(classifyOwnership(undefined, LABEL_OWNERSHIP_KEYS)).toBe("foreign");
  });

  test("tagArrayToMap converts CloudFormation {Key,Value} tags", () => {
    const map = tagArrayToMap([
      { Key: "chant:managed-by", Value: "chant" },
      { Key: "chant:stack", Value: "billing" },
    ]);
    expect(map["chant:managed-by"]).toBe("chant");
    expect(classifyOwnership(map, COLON_KEYS)).toBe("owned");
  });

  test("tagArrayToMap tolerates undefined / malformed entries", () => {
    expect(tagArrayToMap(undefined)).toEqual({});
    expect(tagArrayToMap([{ Value: "no-key" }])).toEqual({});
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
