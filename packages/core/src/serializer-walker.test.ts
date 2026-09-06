import { describe, test, expect } from "vitest";
import { walkValue, type SerializerVisitor } from "./serializer-walker";
import { DECLARABLE_MARKER, type Declarable } from "./declarable";
import { INTRINSIC_MARKER } from "./intrinsic";
import { AttrRef } from "./attrref";
import { createResource } from "./runtime";
import { heldElsewhere } from "./held-elsewhere";

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

  test("resource.Ref resolves via resourceRef", () => {
    const TestTable = createResource("Test::Table", "test", {});
    const resource = new TestTable({}) as unknown as Declarable;
    const names = new Map<Declarable, string>([[resource, "MyTable"]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(walkValue((resource as any).Ref, names, mockVisitor)).toEqual({ __ref: "MyTable" });
  });

  test("resolves __attrRef envelope inside intrinsic toJSON output", () => {
    // Simulate an intrinsic whose toJSON() produces an __attrRef envelope
    // (e.g., AttrRef inside a Sub template literal)
    const intrinsic = {
      [INTRINSIC_MARKER]: true as const,
      toJSON: () => ({
        MyIntrinsic: { __attrRef: { entity: "MyResource", attribute: "Arn" } },
      }),
    };
    const names = new Map<Declarable, string>();
    expect(walkValue(intrinsic, names, mockVisitor)).toEqual({
      MyIntrinsic: { __getAtt: ["MyResource", "Arn"] },
    });
  });

  test("resolves standalone __attrRef envelope in plain object", () => {
    const names = new Map<Declarable, string>();
    const value = { __attrRef: { entity: "MyBucket", attribute: "DomainName" } };
    expect(walkValue(value, names, mockVisitor)).toEqual({
      __getAtt: ["MyBucket", "DomainName"],
    });
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

// #2162 — a `heldElsewhere()` marker is never written to the applied
// payload: the field is omitted entirely so the provider defaults it once at
// creation and the named holder owns it from there. Every apply this
// synthesizes omits it, not only the first — re-asserting even the field's
// own value on a later apply would fight whatever the holder wrote in
// between.
describe("walkValue — heldElsewhere() markers (#2162)", () => {
  test("a top-level held value walks to undefined", () => {
    const names = new Map<Declarable, string>();
    const marker = heldElsewhere<number>({ by: "hpa", reason: "x" });
    expect(walkValue(marker, names, mockVisitor)).toBeUndefined();
  });

  test("an object key holding a marker is omitted entirely, not set to undefined", () => {
    const names = new Map<Declarable, string>();
    const value = {
      replicas: heldElsewhere<number>({ by: "hpa", reason: "the autoscaler owns replicas after the first apply" }),
      image: "app:1",
    };
    const result = walkValue(value, names, mockVisitor);
    expect(result).toEqual({ image: "app:1" });
    expect(Object.keys(result as object)).not.toContain("replicas");
  });

  test("a held element inside an array is dropped, not left as a hole", () => {
    const names = new Map<Declarable, string>();
    const value = { tolerations: ["a", heldElsewhere<string>({ by: "controller", reason: "x" }), "b"] };
    expect(walkValue(value, names, mockVisitor)).toEqual({ tolerations: ["a", "b"] });
  });

  test("nested inside a property-kind declarable's own props, still omitted", () => {
    const names = new Map<Declarable, string>();
    const scaleTarget = makeDeclarable("K8s::Autoscaling::HorizontalPodAutoscaler.Behavior", "property", {
      scaleUp: heldElsewhere<Record<string, unknown>>({ by: "hpa", reason: "the controller tunes its own policy" }),
      stabilizationWindowSeconds: 60,
    });
    const result = walkValue(scaleTarget, names, mockVisitor);
    expect(result).toEqual({ stabilizationWindowSeconds: 60 });
  });
});
