import { describe, expect, test } from "vitest";
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

  // chant #2205 — a branch list beside a real `type` relaxes that type.
  test("reads the sibling type through a oneOf", () => {
    const prop: JsonSchemaProperty = {
      type: "string",
      oneOf: [{ pattern: "^a" }, { pattern: "^b" }],
    };
    expect(resolvePropertyType(prop, emptySchema, defName)).toBe("string");
  });

  test("reads the sibling $ref through an anyOf", () => {
    const schema: JsonSchemaDocument = {
      definitions: { Foo: { properties: { bar: { type: "string" } } } },
    };
    const prop: JsonSchemaProperty = {
      $ref: "#/definitions/Foo",
      anyOf: [{ required: ["bar"] }],
    };
    expect(resolvePropertyType(prop, schema, defName)).toBe("Test_Foo");
  });

  test("an anyOf branch carrying an enum narrows a string property to that union", () => {
    // AWS::AmazonMQ::Broker.EngineType: the enum branch beside case-insensitive
    // patterns for the same two values.
    const prop: JsonSchemaProperty = {
      type: "string",
      anyOf: [
        { type: "string", enum: ["ACTIVEMQ", "RABBITMQ"] },
        { pattern: "^[Aa][Cc][Tt][Ii][Vv][Ee][Mm][Qq]$" },
        { pattern: "^[Rr][Aa][Bb][Bb][Ii][Tt][Mm][Qq]$" },
      ],
    };
    expect(resolvePropertyType(prop, emptySchema, defName)).toBe('"ACTIVEMQ" | "RABBITMQ"');
  });

  test("a non-string enum branch is left alone", () => {
    const prop: JsonSchemaProperty = {
      type: "object",
      anyOf: [{ enum: ["a", "b"] }],
    };
    expect(resolvePropertyType(prop, emptySchema, defName)).toBe("Record<string, any>");
  });

  test("a branch list with nothing beside it stays 'any'", () => {
    const prop: JsonSchemaProperty = {
      oneOf: [
        { type: "object", properties: { Fixed: { type: "string" } } },
        { type: "object", properties: { Below: { type: "string" } } },
      ],
    };
    expect(resolvePropertyType(prop, emptySchema, defName)).toBe("any");
  });

  // chant #2205 — allOf of one $ref and an annotation types as that $ref.
  test("resolves an allOf of a single $ref plus an annotation", () => {
    const schema: JsonSchemaDocument = {
      definitions: { ProtocolType: { type: "string", enum: ["MCP"] } },
    };
    const prop: JsonSchemaProperty = {
      allOf: [{ $ref: "#/definitions/ProtocolType" }, { default: "MCP" }],
    };
    expect(resolvePropertyType(prop, schema, defName)).toBe("Test_ProtocolType");
  });

  test("leaves an allOf that intersects two real shapes as 'any'", () => {
    const schema: JsonSchemaDocument = {
      definitions: {
        A: { properties: { a: { type: "string" } } },
        B: { properties: { b: { type: "string" } } },
      },
    };
    const prop: JsonSchemaProperty = {
      allOf: [{ $ref: "#/definitions/A" }, { $ref: "#/definitions/B" }],
    };
    expect(resolvePropertyType(prop, schema, defName)).toBe("any");
  });

  // chant #2205 — `[]` binds tighter than `|`.
  test("parenthesizes a union inside an array", () => {
    const prop: JsonSchemaProperty = {
      type: "array",
      items: { type: "string", enum: ["arm64", "x86_64"] },
    };
    expect(resolvePropertyType(prop, emptySchema, defName)).toBe('("arm64" | "x86_64")[]');
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

  // chant #2205 — CloudFormation names its list shapes, and a `$ref` to one
  // used to fall through to "any".
  test("resolves an array definition through its items", () => {
    const schema: JsonSchemaDocument = {
      definitions: {
        TagList: { type: "array", items: { $ref: "#/definitions/Tag" } },
        Tag: { properties: { Key: { type: "string" }, Value: { type: "string" } } },
      },
    };
    expect(resolveRef("#/definitions/TagList", schema, defName)).toBe("Test_Tag[]");
  });

  test("resolves an array definition of scalars", () => {
    const schema: JsonSchemaDocument = {
      definitions: { Names: { type: "array", items: { type: "string" } } },
    };
    expect(resolveRef("#/definitions/Names", schema, defName)).toBe("string[]");
  });

  test("resolves an array definition with no items to 'any[]'", () => {
    const schema: JsonSchemaDocument = {
      definitions: { Loose: { type: "array" } },
    };
    expect(resolveRef("#/definitions/Loose", schema, defName)).toBe("any[]");
  });

  test("parenthesizes a union inside an array definition", () => {
    const schema: JsonSchemaDocument = {
      definitions: { Modes: { type: "array", items: { type: "string", enum: ["b", "a"] } } },
    };
    expect(resolveRef("#/definitions/Modes", schema, defName)).toBe('("a" | "b")[]');
  });

  test("a list definition that reaches itself terminates", () => {
    const schema: JsonSchemaDocument = {
      definitions: { Tree: { type: "array", items: { $ref: "#/definitions/Tree" } } },
    };
    expect(resolveRef("#/definitions/Tree", schema, defName)).toBe("any[]");
  });

  test("a definition that is an allOf of one $ref resolves as that $ref", () => {
    const schema: JsonSchemaDocument = {
      definitions: {
        Wrapped: { allOf: [{ $ref: "#/definitions/Inner" }, { default: "x" }] },
        Inner: { properties: { a: { type: "string" } } },
      },
    };
    expect(resolveRef("#/definitions/Wrapped", schema, defName)).toBe("Test_Inner");
  });

  test("a definition that is a sum of object branches stays 'any'", () => {
    const schema: JsonSchemaDocument = {
      definitions: {
        FieldPosition: {
          oneOf: [
            { type: "object", properties: { Fixed: { type: "string" } } },
            { type: "object", properties: { Below: { type: "string" } } },
          ],
        },
      },
    };
    expect(resolveRef("#/definitions/FieldPosition", schema, defName)).toBe("any");
  });

  test("a nested list definition resolves through both hops", () => {
    const schema: JsonSchemaDocument = {
      definitions: {
        Matrix: { type: "array", items: { $ref: "#/definitions/Row" } },
        Row: { type: "array", items: { type: "number" } },
      },
    };
    expect(resolveRef("#/definitions/Matrix", schema, defName)).toBe("number[][]");
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
