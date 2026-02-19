import { describe, test, expect } from "bun:test";
import { walkValue, type SerializerVisitor } from "./serializer-walker";
import { DECLARABLE_MARKER, type Declarable } from "./declarable";
import { INTRINSIC_MARKER } from "./intrinsic";
import { AttrRef } from "./attrref";

function makeDeclarable(type: string, kind: "resource" | "property" = "resource", props?: Record<string, unknown>): Declarable & { props?: Record<string, unknown> } {
  const d: Declarable & { props?: Record<string, unknown> } = {
    lexicon: "test",
    entityType: type,
    kind,
    [DECLARABLE_MARKER]: true as const,
  };
  if (props) d.props = props;
  return d;
}

const mockVisitor: SerializerVisitor = {
  attrRef: (name, attr) => ({ __getAtt: [name, attr] }),
  resourceRef: (name) => ({ __ref: name }),
  propertyDeclarable: (entity, walk) => {
    if (!("props" in entity) || typeof entity.props !== "object" || entity.props === null) {
      return undefined;
    }
    const props = entity.props as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (v !== undefined) result[k] = walk(v);
    }
    return Object.keys(result).length > 0 ? result : undefined;
  },
};

describe("walkValue", () => {
  test("returns null and undefined as-is", () => {
    const names = new Map<Declarable, string>();
    expect(walkValue(null, names, mockVisitor)).toBe(null);
    expect(walkValue(undefined, names, mockVisitor)).toBe(undefined);
  });

  test("returns primitives as-is", () => {
    const names = new Map<Declarable, string>();
    expect(walkValue(42, names, mockVisitor)).toBe(42);
    expect(walkValue("hello", names, mockVisitor)).toBe("hello");
    expect(walkValue(true, names, mockVisitor)).toBe(true);
  });

  test("handles AttrRef", () => {
    const parent = makeDeclarable("Test::Resource");
    const ref = new AttrRef(parent, "arn");
    ref._setLogicalName("MyResource");

    const names = new Map<Declarable, string>([[parent, "MyResource"]]);
    expect(walkValue(ref, names, mockVisitor)).toEqual({ __getAtt: ["MyResource", "arn"] });
  });

  test("throws for AttrRef without logical name", () => {
    const parent = makeDeclarable("Test::Resource");
    const ref = new AttrRef(parent, "arn");

    const names = new Map<Declarable, string>();
    expect(() => walkValue(ref, names, mockVisitor)).toThrow("logical name not set");
  });

  test("handles intrinsic with toJSON", () => {
    const intrinsic = {
      [INTRINSIC_MARKER]: true as const,
      toJSON: () => ({ MyIntrinsic: "value" }),
    };
    const names = new Map<Declarable, string>();
    expect(walkValue(intrinsic, names, mockVisitor)).toEqual({ MyIntrinsic: "value" });
  });

  test("handles resource Declarable via resourceRef", () => {
    const resource = makeDeclarable("Test::Bucket");
    const names = new Map<Declarable, string>([[resource, "MyBucket"]]);
    expect(walkValue(resource, names, mockVisitor)).toEqual({ __ref: "MyBucket" });
  });

  test("handles property Declarable via propertyDeclarable", () => {
    const prop = makeDeclarable("Test::Config", "property", { key: "value" });
    const names = new Map<Declarable, string>();
    expect(walkValue(prop, names, mockVisitor)).toEqual({ key: "value" });
  });

  test("recurses into arrays", () => {
    const names = new Map<Declarable, string>();
    expect(walkValue([1, "two", [3]], names, mockVisitor)).toEqual([1, "two", [3]]);
  });

  test("recurses into objects", () => {
    const names = new Map<Declarable, string>();
    expect(walkValue({ a: 1, b: { c: 2 } }, names, mockVisitor)).toEqual({ a: 1, b: { c: 2 } });
  });

  test("applies transformKey when provided", () => {
    const visitor: SerializerVisitor = {
      ...mockVisitor,
      transformKey: (k) => k.toUpperCase(),
    };
    const names = new Map<Declarable, string>();
    expect(walkValue({ foo: 1, bar: 2 }, names, visitor)).toEqual({ FOO: 1, BAR: 2 });
  });

  test("complex nested structure", () => {
    const resource = makeDeclarable("Test::Role");
    const ref = new AttrRef(resource, "arn");
    ref._setLogicalName("MyRole");

    const names = new Map<Declarable, string>([[resource, "MyRole"]]);
    const value = {
      config: {
        role: resource,
        items: [ref, "static"],
      },
    };
    expect(walkValue(value, names, mockVisitor)).toEqual({
      config: {
        role: { __ref: "MyRole" },
        items: [{ __getAtt: ["MyRole", "arn"] }, "static"],
      },
    });
  });
});
