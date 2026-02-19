import { describe, test, expect } from "bun:test";
import {
  LOGICAL_NAME_SYMBOL,
  getAttributes,
  getLogicalName,
} from "./utils";
import { AttrRef } from "./attrref";
import type { Declarable } from "./declarable";
import { DECLARABLE_MARKER } from "./declarable";

describe("LOGICAL_NAME_SYMBOL", () => {
  test("is a symbol", () => {
    expect(typeof LOGICAL_NAME_SYMBOL).toBe("symbol");
  });

  test("uses Symbol.for for global registry", () => {
    expect(LOGICAL_NAME_SYMBOL).toBe(Symbol.for("chant.logicalName"));
  });
});

describe("getAttributes", () => {
  test("returns empty array for entity with no AttrRef properties", () => {
    const entity: Declarable = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
      prop1: "value",
      prop2: 123,
    };

    const attributes = getAttributes(entity);
    expect(attributes).toEqual([]);
  });

  test("returns property names with AttrRef values", () => {
    const parent = {};
    const entity: Declarable & { arn: AttrRef; name: AttrRef } = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
      arn: new AttrRef(parent, "Arn"),
      name: new AttrRef(parent, "Name"),
    };

    const attributes = getAttributes(entity);
    expect(attributes).toContain("arn");
    expect(attributes).toContain("name");
    expect(attributes).toHaveLength(2);
  });

  test("ignores non-AttrRef properties", () => {
    const parent = {};
    const entity: Declarable & {
      arn: AttrRef;
      regularProp: string;
      numberProp: number;
    } = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
      arn: new AttrRef(parent, "Arn"),
      regularProp: "value",
      numberProp: 42,
    };

    const attributes = getAttributes(entity);
    expect(attributes).toEqual(["arn"]);
  });

  test("returns attributes in order they appear", () => {
    const parent = {};
    const entity: Declarable & {
      first: AttrRef;
      second: AttrRef;
      third: AttrRef;
    } = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
      first: new AttrRef(parent, "First"),
      second: new AttrRef(parent, "Second"),
      third: new AttrRef(parent, "Third"),
    };

    const attributes = getAttributes(entity);
    expect(attributes).toEqual(["first", "second", "third"]);
  });

  test("handles entity with mixed property types", () => {
    const parent = {};
    const entity: Declarable & {
      attrRef: AttrRef;
      string: string;
      number: number;
      boolean: boolean;
      object: object;
      anotherAttrRef: AttrRef;
    } = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
      attrRef: new AttrRef(parent, "Attr1"),
      string: "test",
      number: 123,
      boolean: true,
      object: {},
      anotherAttrRef: new AttrRef(parent, "Attr2"),
    };

    const attributes = getAttributes(entity);
    expect(attributes).toContain("attrRef");
    expect(attributes).toContain("anotherAttrRef");
    expect(attributes).toHaveLength(2);
  });
});

describe("getLogicalName", () => {
  test("returns logical name when set", () => {
    const entity: Declarable & Record<symbol, unknown> = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
      [LOGICAL_NAME_SYMBOL]: "MyResource",
    };

    const name = getLogicalName(entity);
    expect(name).toBe("MyResource");
  });

  test("throws when logical name is not set", () => {
    const entity: Declarable = {
      entityType: "TestEntity",
      [DECLARABLE_MARKER]: true,
    };

    expect(() => getLogicalName(entity)).toThrow(
      'Logical name not set on entity of type "TestEntity"'
    );
  });

  test("throws when logical name is not a string", () => {
    const entity: Declarable & Record<symbol, unknown> = {
      entityType: "TestEntity",
      [DECLARABLE_MARKER]: true,
      [LOGICAL_NAME_SYMBOL]: 123,
    };

    expect(() => getLogicalName(entity)).toThrow(
      'Logical name not set on entity of type "TestEntity"'
    );
  });

  test("handles different logical name values", () => {
    const names = ["MyBucket", "MyTable", "My-Function-123", "Resource_1"];

    for (const name of names) {
      const entity: Declarable & Record<symbol, unknown> = {
        entityType: "Test",
        [DECLARABLE_MARKER]: true,
        [LOGICAL_NAME_SYMBOL]: name,
      };

      expect(getLogicalName(entity)).toBe(name);
    }
  });

  test("includes entity type in error message", () => {
    const entity: Declarable = {
      entityType: "MyCustomType",
      [DECLARABLE_MARKER]: true,
    };

    expect(() => getLogicalName(entity)).toThrow(
      'Logical name not set on entity of type "MyCustomType"'
    );
  });

  test("throws when logical name is undefined", () => {
    const entity: Declarable & Record<symbol, unknown> = {
      entityType: "TestEntity",
      [DECLARABLE_MARKER]: true,
      [LOGICAL_NAME_SYMBOL]: undefined,
    };

    expect(() => getLogicalName(entity)).toThrow(
      'Logical name not set on entity of type "TestEntity"'
    );
  });

  test("throws when logical name is null", () => {
    const entity: Declarable & Record<symbol, unknown> = {
      entityType: "TestEntity",
      [DECLARABLE_MARKER]: true,
      [LOGICAL_NAME_SYMBOL]: null,
    };

    expect(() => getLogicalName(entity)).toThrow(
      'Logical name not set on entity of type "TestEntity"'
    );
  });
});
