import { describe, expect, test } from "bun:test";
import {
  resolvePropertyType,
  resolveRef,
  extractConstraints,
  constraintsIsEmpty,
  isEnumDefinition,
  primaryType,
  type JsonSchemaDocument,
  type JsonSchemaProperty,
} from "./json-schema";

describe("primaryType", () => {
  test("returns 'any' for undefined", () => {
    expect(primaryType(undefined)).toBe("any");
  });

  test("returns string type directly", () => {
    expect(primaryType("string")).toBe("string");
    expect(primaryType("integer")).toBe("integer");
  });

  test("returns first non-null from array", () => {
    expect(primaryType(["null", "string"])).toBe("string");
    expect(primaryType(["number", "null"])).toBe("number");
  });

  test("returns first element if all are null", () => {
    expect(primaryType(["null"])).toBe("null");
  });

  test("returns 'any' for empty array", () => {
    expect(primaryType([])).toBe("any");
  });
});

describe("resolvePropertyType", () => {
  const emptySchema: JsonSchemaDocument = {};
  const defName = (name: string) => `Test_${name}`;

  test("returns 'any' for undefined prop", () => {
    expect(resolvePropertyType(undefined, emptySchema, defName)).toBe("any");
  });

  test("resolves string type", () => {
    expect(resolvePropertyType({ type: "string" }, emptySchema, defName)).toBe("string");
  });

  test("resolves integer/number types to 'number'", () => {
    expect(resolvePropertyType({ type: "integer" }, emptySchema, defName)).toBe("number");
    expect(resolvePropertyType({ type: "number" }, emptySchema, defName)).toBe("number");
  });

  test("resolves boolean type", () => {
    expect(resolvePropertyType({ type: "boolean" }, emptySchema, defName)).toBe("boolean");
  });

  test("resolves array with items", () => {
    const prop: JsonSchemaProperty = { type: "array", items: { type: "string" } };
    expect(resolvePropertyType(prop, emptySchema, defName)).toBe("string[]");
  });

  test("resolves array without items", () => {
    expect(resolvePropertyType({ type: "array" }, emptySchema, defName)).toBe("any[]");
  });

  test("resolves object type", () => {
    expect(resolvePropertyType({ type: "object" }, emptySchema, defName)).toBe("Record<string, any>");
  });

  test("resolves $ref to object definition", () => {
    const schema: JsonSchemaDocument = {
      definitions: { Foo: { properties: { bar: { type: "string" } } } },
    };
    expect(resolvePropertyType({ $ref: "#/definitions/Foo" }, schema, defName)).toBe("Test_Foo");
  });

  test("resolves $ref to enum definition using resolveDefName", () => {
    const schema: JsonSchemaDocument = {
      definitions: { Status: { enum: ["a", "b"] } },
    };
    expect(resolvePropertyType({ $ref: "#/definitions/Status" }, schema, defName)).toBe("Test_Status");
  });

  test("resolves $ref to enum definition as 'string' when resolveDefName is null", () => {
    const schema: JsonSchemaDocument = {
      definitions: { Status: { enum: ["a", "b"] } },
    };
    expect(resolvePropertyType({ $ref: "#/definitions/Status" }, schema, null)).toBe("string");
  });

  test("resolves inline string enum to union type", () => {
    const prop: JsonSchemaProperty = { type: "string", enum: ["c", "a", "b"] };
    expect(resolvePropertyType(prop, emptySchema, defName)).toBe('"a" | "b" | "c"');
  });

  test("resolves oneOf to 'any'", () => {
    const prop: JsonSchemaProperty = { oneOf: [{ type: "string" }, { type: "number" }] };
    expect(resolvePropertyType(prop, emptySchema, defName)).toBe("any");
  });

  test("resolves anyOf to 'any'", () => {
    const prop: JsonSchemaProperty = { anyOf: [{ type: "string" }] };
    expect(resolvePropertyType(prop, emptySchema, defName)).toBe("any");
  });

  test("resolves $ref with null resolveDefName to 'any' for objects", () => {
    const schema: JsonSchemaDocument = {
      definitions: { Foo: { properties: { bar: { type: "string" } } } },
    };
    expect(resolvePropertyType({ $ref: "#/definitions/Foo" }, schema, null)).toBe("any");
  });
});

describe("resolveRef", () => {
  const defName = (name: string) => `Test_${name}`;

  test("returns 'any' for non-definitions ref", () => {
    expect(resolveRef("#/other/Foo", {}, defName)).toBe("any");
  });

  test("returns 'any' for missing definition", () => {
    expect(resolveRef("#/definitions/Missing", {}, defName)).toBe("any");
  });

  test("resolves primitive definition", () => {
    const schema: JsonSchemaDocument = {
      definitions: { Count: { type: "integer" } },
    };
    expect(resolveRef("#/definitions/Count", schema, defName)).toBe("number");
  });
});

describe("extractConstraints", () => {
  test("extracts all constraint fields", () => {
    const c = extractConstraints({
      pattern: "^[a-z]+$",
      minLength: 1,
      maxLength: 100,
      minimum: 0,
      maximum: 999,
      format: "email",
      const: "fixed",
      default: "hello",
      enum: ["a", "b"],
    });
    expect(c.pattern).toBe("^[a-z]+$");
    expect(c.minLength).toBe(1);
    expect(c.maxLength).toBe(100);
    expect(c.minimum).toBe(0);
    expect(c.maximum).toBe(999);
    expect(c.format).toBe("email");
    expect(c.const).toBe("fixed");
    expect(c.default).toBe("hello");
    expect(c.enum).toEqual(["a", "b"]);
  });

  test("returns empty object for no constraints", () => {
    const c = extractConstraints({});
    expect(c).toEqual({});
  });
});

describe("constraintsIsEmpty", () => {
  test("returns true for empty constraints", () => {
    expect(constraintsIsEmpty({})).toBe(true);
  });

  test("returns false when any field is set", () => {
    expect(constraintsIsEmpty({ pattern: "x" })).toBe(false);
    expect(constraintsIsEmpty({ minLength: 0 })).toBe(false);
    expect(constraintsIsEmpty({ enum: ["a"] })).toBe(false);
  });

  test("returns true for empty enum array", () => {
    expect(constraintsIsEmpty({ enum: [] })).toBe(true);
  });
});

describe("isEnumDefinition", () => {
  test("returns true for enum without properties", () => {
    expect(isEnumDefinition({ enum: ["a", "b"] })).toBe(true);
  });

  test("returns false for enum with properties", () => {
    expect(isEnumDefinition({ enum: ["a"], properties: { x: { type: "string" } } })).toBe(false);
  });

  test("returns false for no enum", () => {
    expect(isEnumDefinition({ properties: { x: { type: "string" } } })).toBe(false);
  });

  test("returns false for empty enum", () => {
    expect(isEnumDefinition({ enum: [] })).toBe(false);
  });
});
