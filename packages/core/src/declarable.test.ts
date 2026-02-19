import { describe, test, expect } from "bun:test";
import {
  DECLARABLE_MARKER,
  type Declarable,
  isDeclarable,
  isPropertyDeclarable,
} from "./declarable";

describe("DECLARABLE_MARKER", () => {
  test("is a symbol", () => {
    expect(typeof DECLARABLE_MARKER).toBe("symbol");
  });

  test("uses Symbol.for for global registry", () => {
    expect(DECLARABLE_MARKER).toBe(Symbol.for("chant.declarable"));
  });
});

describe("isDeclarable", () => {
  test("returns true for object with DECLARABLE_MARKER", () => {
    const obj: Declarable = {
      lexicon: "test",
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
    };

    expect(isDeclarable(obj)).toBe(true);
  });

  test("returns true for object with kind field", () => {
    const resourceObj: Declarable = {
      lexicon: "test",
      entityType: "Resource",
      kind: "resource",
      [DECLARABLE_MARKER]: true,
    };
    const propertyObj: Declarable = {
      lexicon: "test",
      entityType: "Property",
      kind: "property",
      [DECLARABLE_MARKER]: true,
    };

    expect(isDeclarable(resourceObj)).toBe(true);
    expect(isDeclarable(propertyObj)).toBe(true);
  });

  test("returns false for object without DECLARABLE_MARKER", () => {
    const obj = {
      entityType: "Test",
    };

    expect(isDeclarable(obj)).toBe(false);
  });

  test("returns false for null", () => {
    expect(isDeclarable(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isDeclarable(undefined)).toBe(false);
  });

  test("returns false for primitive values", () => {
    expect(isDeclarable("string")).toBe(false);
    expect(isDeclarable(123)).toBe(false);
    expect(isDeclarable(true)).toBe(false);
  });

  test("returns false for object with DECLARABLE_MARKER but wrong value", () => {
    const obj = {
      entityType: "Test",
      [DECLARABLE_MARKER]: false,
    };

    expect(isDeclarable(obj)).toBe(false);
  });
});

describe("isPropertyDeclarable", () => {
  test("returns true for Declarable with kind property", () => {
    const obj: Declarable = {
      lexicon: "test",
      entityType: "Property",
      kind: "property",
      [DECLARABLE_MARKER]: true,
    };

    expect(isPropertyDeclarable(obj)).toBe(true);
  });

  test("returns false for Declarable with kind resource", () => {
    const obj: Declarable = {
      lexicon: "test",
      entityType: "Resource",
      kind: "resource",
      [DECLARABLE_MARKER]: true,
    };

    expect(isPropertyDeclarable(obj)).toBe(false);
  });

  test("returns false for Declarable without kind field", () => {
    const obj: Declarable = {
      lexicon: "test",
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
    };

    expect(isPropertyDeclarable(obj)).toBe(false);
  });

  test("returns false for Declarable with undefined kind", () => {
    const obj: Declarable = {
      lexicon: "test",
      entityType: "Test",
      kind: undefined,
      [DECLARABLE_MARKER]: true,
    };

    expect(isPropertyDeclarable(obj)).toBe(false);
  });
});

describe("Declarable interface", () => {
  test("allows creating objects without kind field (backward compatibility)", () => {
    const obj: Declarable = {
      lexicon: "test",
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
    };

    expect(obj.entityType).toBe("Test");
    expect(obj.kind).toBeUndefined();
  });

  test("allows creating objects with kind resource", () => {
    const obj: Declarable = {
      lexicon: "test",
      entityType: "Bucket",
      kind: "resource",
      [DECLARABLE_MARKER]: true,
    };

    expect(obj.entityType).toBe("Bucket");
    expect(obj.kind).toBe("resource");
  });

  test("allows creating objects with kind property", () => {
    const obj: Declarable = {
      lexicon: "test",
      entityType: "BucketEncryption",
      kind: "property",
      [DECLARABLE_MARKER]: true,
    };

    expect(obj.entityType).toBe("BucketEncryption");
    expect(obj.kind).toBe("property");
  });
});
