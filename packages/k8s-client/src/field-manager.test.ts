/**
 * chant's field-manager identity (chant #1075).
 *
 * The scheme is small enough to state in one line — `chant`, or `chant:<stack>`
 * — so what is worth testing is the edges: that it is derived from the same
 * `ownership.stack` the label marker uses, that it round-trips, and that an
 * identity the API server would reject fails here, where the config key
 * responsible can be named.
 */

import { describe, test, expect } from "vitest";
import {
  CHANT_FIELD_MANAGER,
  FIELD_MANAGER_MAX_LENGTH,
  assertValidFieldManager,
  chantStackOf,
  fieldManagerFor,
  isChantFieldManager,
} from "./field-manager";
import { FieldManagerError } from "./errors";

describe("fieldManagerFor", () => {
  test("no ownership stack yields the bare chant", () => {
    expect(fieldManagerFor()).toBe("chant");
    expect(fieldManagerFor({})).toBe("chant");
    expect(fieldManagerFor({ stack: "" })).toBe("chant");
    expect(fieldManagerFor({ stack: "   " })).toBe("chant");
  });

  test("a stack qualifies it — the identity the ownership label already carries", () => {
    expect(fieldManagerFor({ stack: "web" })).toBe("chant:web");
    expect(fieldManagerFor({ stack: "platform-prod" })).toBe("chant:platform-prod");
  });

  test("two stacks on one cluster are two managers, which is the point", () => {
    expect(fieldManagerFor({ stack: "a" })).not.toBe(fieldManagerFor({ stack: "b" }));
  });

  test("it is stable — the same stack derives the same manager every time", () => {
    expect(fieldManagerFor({ stack: "web" })).toBe(fieldManagerFor({ stack: "web" }));
  });

  test("surrounding whitespace is trimmed rather than baked into the identity", () => {
    expect(fieldManagerFor({ stack: "  web  " })).toBe("chant:web");
  });
});

describe("recognising chant's own managers", () => {
  test("qualified and unqualified are both chant's", () => {
    expect(isChantFieldManager("chant")).toBe(true);
    expect(isChantFieldManager("chant:web")).toBe(true);
  });

  test("another tool's manager is not, and neither is a lookalike prefix", () => {
    for (const other of ["kubectl", "helm", "argo-controller", "chanted", "chant-ish", "", undefined]) {
      expect(isChantFieldManager(other)).toBe(false);
    }
  });

  test("the stack round-trips out of the manager", () => {
    expect(chantStackOf(fieldManagerFor({ stack: "web" }))).toBe("web");
    expect(chantStackOf("chant")).toBeUndefined();
    expect(chantStackOf("kubectl")).toBeUndefined();
    expect(chantStackOf(undefined)).toBeUndefined();
  });

  test("a stack containing the separator still round-trips whole", () => {
    const manager = fieldManagerFor({ stack: "team:web" });
    expect(manager).toBe("chant:team:web");
    expect(chantStackOf(manager)).toBe("team:web");
  });
});

describe("identities the API server would reject fail here instead", () => {
  test("over the length ceiling, naming the config key", () => {
    const stack = "s".repeat(FIELD_MANAGER_MAX_LENGTH);
    const err = (() => {
      try {
        fieldManagerFor({ stack });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(FieldManagerError);
    expect(String(err)).toContain("ownership.stack");
    expect(String(err)).toContain(String(FIELD_MANAGER_MAX_LENGTH));
  });

  test("an interior space, which would otherwise arrive as a 400 from a cluster", () => {
    expect(() => fieldManagerFor({ stack: "web prod" })).toThrow(FieldManagerError);
  });

  test("a control character", () => {
    expect(() => fieldManagerFor({ stack: `web${String.fromCharCode(9)}prod` })).toThrow(FieldManagerError);
  });

  test("an explicitly supplied manager is checked the same way", () => {
    expect(() => assertValidFieldManager("")).toThrow(FieldManagerError);
    expect(() => assertValidFieldManager("a".repeat(FIELD_MANAGER_MAX_LENGTH + 1))).toThrow(FieldManagerError);
    expect(() => assertValidFieldManager(CHANT_FIELD_MANAGER)).not.toThrow();
    // Someone else's manager is a legal value — this validates syntax, not ownership.
    expect(() => assertValidFieldManager("kubectl-client-side-apply")).not.toThrow();
  });

  test("a stack exactly at the ceiling is allowed", () => {
    const stack = "s".repeat(FIELD_MANAGER_MAX_LENGTH - "chant:".length);
    expect(fieldManagerFor({ stack })).toHaveLength(FIELD_MANAGER_MAX_LENGTH);
  });
});
