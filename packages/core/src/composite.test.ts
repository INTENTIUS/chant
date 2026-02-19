import { describe, test, expect, beforeEach } from "bun:test";
import {
  Composite,
  isCompositeInstance,
  expandComposite,
  CompositeRegistry,
  COMPOSITE_MARKER,
  resource,
  withDefaults,
  propagate,
  SHARED_PROPS,
} from "./composite";
import { DECLARABLE_MARKER, type Declarable } from "./declarable";
import { AttrRef } from "./attrref";

function mockDeclarable(type = "TestEntity", lexicon = "test"): Declarable {
  return {
    lexicon,
    entityType: type,
    kind: "resource",
    [DECLARABLE_MARKER]: true,
  } as Declarable;
}

class MockResource implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "test";
  readonly entityType: string;
  readonly kind = "resource" as const;
  readonly arn: AttrRef;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.entityType = (props.type as string) ?? "TestResource";
    this.props = props;
    this.arn = new AttrRef(this, "Arn");
  }
}

describe("Composite", () => {
  beforeEach(() => {
    CompositeRegistry.clear();
  });

  test("creates a callable composite definition", () => {
    const MyComp = Composite<{ name: string }>((props) => ({
      item: mockDeclarable(props.name),
    }));

    expect(typeof MyComp).toBe("function");
    expect(MyComp.compositeName).toBe("anonymous");
  });

  test("returns CompositeInstance with marker", () => {
    const MyComp = Composite<{}>(() => ({
      item: mockDeclarable(),
    }));

    const instance = MyComp({});
    expect(instance[COMPOSITE_MARKER]).toBe(true);
    expect(instance.members).toBeDefined();
  });

  test("members contain the Declarables from the factory", () => {
    const MyComp = Composite<{ name: string }>((props) => ({
      bucket: mockDeclarable(`Bucket-${props.name}`),
      role: mockDeclarable(`Role-${props.name}`),
    }));

    const instance = MyComp({ name: "test" });
    expect(Object.keys(instance.members)).toEqual(["bucket", "role"]);
    expect(instance.members.bucket.entityType).toBe("Bucket-test");
    expect(instance.members.role.entityType).toBe("Role-test");
  });

  test("props are forwarded to the factory", () => {
    let receivedProps: { x: number } | undefined;
    const MyComp = Composite<{ x: number }>((props) => {
      receivedProps = props;
      return { item: mockDeclarable() };
    });

    MyComp({ x: 42 });
    expect(receivedProps).toEqual({ x: 42 });
  });

  test("members are accessible as top-level properties", () => {
    const MyComp = Composite<{}>(() => ({
      bucket: mockDeclarable("Bucket"),
      role: mockDeclarable("Role"),
    }));

    const instance = MyComp({});
    expect(instance.bucket.entityType).toBe("Bucket");
    expect(instance.role.entityType).toBe("Role");
  });

  test("throws if factory returns a non-Declarable member", () => {
    const BadComp = Composite<{}>(() => ({
      notDeclarable: "oops" as unknown as Declarable,
    }));

    expect(() => BadComp({})).toThrow('member "notDeclarable" is not a Declarable');
  });

  test("sets compositeName when provided", () => {
    const Named = Composite<{}>(() => ({ item: mockDeclarable() }), "MyComposite");
    expect(Named.compositeName).toBe("MyComposite");
  });

  test("supports AttrRef cross-references between members", () => {
    const MyComp = Composite<{}>(() => {
      const bucket = new MockResource({ type: "Bucket" });
      const role = new MockResource({ type: "Role", bucketArn: bucket.arn });
      return { bucket, role };
    });

    const instance = MyComp({});
    const roleProps = instance.members.role.props as Record<string, unknown>;
    expect(roleProps.bucketArn).toBeInstanceOf(AttrRef);
    // The AttrRef's parent should be the bucket instance
    expect((roleProps.bucketArn as AttrRef).attribute).toBe("Arn");
  });
});

describe("isCompositeInstance", () => {
  test("returns true for a valid CompositeInstance", () => {
    const MyComp = Composite<{}>(() => ({ item: mockDeclarable() }));
    expect(isCompositeInstance(MyComp({}))).toBe(true);
  });

  test("returns false for a plain Declarable", () => {
    expect(isCompositeInstance(mockDeclarable())).toBe(false);
  });

  test("returns false for null, undefined, primitives, plain objects", () => {
    expect(isCompositeInstance(null)).toBe(false);
    expect(isCompositeInstance(undefined)).toBe(false);
    expect(isCompositeInstance(42)).toBe(false);
    expect(isCompositeInstance("string")).toBe(false);
    expect(isCompositeInstance({ members: {} })).toBe(false);
  });
});

describe("expandComposite", () => {
  test("expands a simple composite into prefixed entities", () => {
    const MyComp = Composite<{}>(() => ({
      bucket: mockDeclarable("Bucket"),
      role: mockDeclarable("Role"),
    }));

    const expanded = expandComposite("storage", MyComp({}));
    expect(expanded.size).toBe(2);
    expect(expanded.get("storage_bucket")?.entityType).toBe("Bucket");
    expect(expanded.get("storage_role")?.entityType).toBe("Role");
  });

  test("handles nested composites", () => {
    const Inner = Composite<{}>(() => ({
      table: mockDeclarable("Table"),
    }));

    const Outer = Composite<{}>(() => ({
      bucket: mockDeclarable("Bucket"),
      nested: Inner({}) as unknown as Declarable,
    }));

    const expanded = expandComposite("app", Outer({}));
    expect(expanded.size).toBe(2);
    expect(expanded.get("app_bucket")?.entityType).toBe("Bucket");
    expect(expanded.get("app_nested_table")?.entityType).toBe("Table");
  });

  test("preserves Declarable identity (same object reference)", () => {
    const bucket = mockDeclarable("Bucket");
    const MyComp = Composite<{}>(() => ({ bucket }));

    const expanded = expandComposite("s", MyComp({}));
    expect(expanded.get("s_bucket")).toBe(bucket);
  });

  test("handles empty composite", () => {
    const Empty = Composite<{}>(() => ({} as Record<string, Declarable>));
    const expanded = expandComposite("e", Empty({}));
    expect(expanded.size).toBe(0);
  });
});

describe("CompositeRegistry", () => {
  beforeEach(() => {
    CompositeRegistry.clear();
  });

  test("auto-registers when Composite() is called", () => {
    expect(CompositeRegistry.size).toBe(0);
    Composite<{}>(() => ({ item: mockDeclarable() }));
    expect(CompositeRegistry.size).toBe(1);
  });

  test("getAll returns all registered definitions", () => {
    Composite<{}>(() => ({ a: mockDeclarable() }), "A");
    Composite<{}>(() => ({ b: mockDeclarable() }), "B");
    const all = CompositeRegistry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((d) => d.compositeName)).toContain("A");
    expect(all.map((d) => d.compositeName)).toContain("B");
  });

  test("clear empties the registry", () => {
    Composite<{}>(() => ({ item: mockDeclarable() }));
    expect(CompositeRegistry.size).toBe(1);
    CompositeRegistry.clear();
    expect(CompositeRegistry.size).toBe(0);
  });
});

describe("resource() helper", () => {
  test("returns an instance of the given class", () => {
    const instance = resource(MockResource, { type: "Bucket" });
    expect(instance).toBeInstanceOf(MockResource);
    expect(instance.entityType).toBe("Bucket");
  });

  test("passes props correctly", () => {
    const instance = resource(MockResource, { type: "Lambda", memory: 512 });
    expect(instance.props.memory).toBe(512);
  });

  test("returned instance has AttrRef attributes", () => {
    const instance = resource(MockResource, {});
    expect(instance.arn).toBeInstanceOf(AttrRef);
  });
});

function mockDeclarableWithProps(type: string, props: Record<string, unknown>): Declarable {
  const d = {
    lexicon: "test",
    entityType: type,
    kind: "resource" as const,
    [DECLARABLE_MARKER]: true,
    props,
  } as Declarable;
  Object.defineProperty(d, "props", { value: props, enumerable: false, configurable: true });
  return d;
}

describe("withDefaults", () => {
  beforeEach(() => {
    CompositeRegistry.clear();
  });

  test("defaulted props become optional, non-defaulted stay required", () => {
    const Base = Composite<{ name: string; timeout: number }>((props) => ({
      item: mockDeclarable(props.name),
    }), "Base");

    const Wrapped = withDefaults(Base, { timeout: 30 });
    // Can call without timeout
    const instance = Wrapped({ name: "test" });
    expect(instance.members.item.entityType).toBe("test");
  });

  test("caller can override a default", () => {
    let received: { timeout: number } | undefined;
    const Base = Composite<{ timeout: number }>((props) => {
      received = props;
      return { item: mockDeclarable() };
    });

    const Wrapped = withDefaults(Base, { timeout: 30 });
    Wrapped({ timeout: 60 });
    expect(received!.timeout).toBe(60);
  });

  test("default value is used when prop is not provided", () => {
    let received: { timeout: number } | undefined;
    const Base = Composite<{ timeout: number }>((props) => {
      received = props;
      return { item: mockDeclarable() };
    });

    const Wrapped = withDefaults(Base, { timeout: 30 });
    Wrapped({});
    expect(received!.timeout).toBe(30);
  });

  test("composition: withDefaults(withDefaults(base, d1), d2) works", () => {
    let received: { a: number; b: number; c: number } | undefined;
    const Base = Composite<{ a: number; b: number; c: number }>((props) => {
      received = props;
      return { item: mockDeclarable() };
    });

    const Step1 = withDefaults(Base, { a: 1 });
    const Step2 = withDefaults(Step1, { b: 2 });
    Step2({ c: 3 });
    expect(received).toEqual({ a: 1, b: 2, c: 3 });
  });

  test("wrapped definition shares _id and compositeName", () => {
    const Base = Composite<{ x: number }>(() => ({ item: mockDeclarable() }), "Named");
    const Wrapped = withDefaults(Base, { x: 1 });

    expect(Wrapped._id).toBe(Base._id);
    expect(Wrapped.compositeName).toBe("Named");
  });

  test("withDefaults does not add a new registry entry", () => {
    const Base = Composite<{ x: number }>(() => ({ item: mockDeclarable() }));
    expect(CompositeRegistry.size).toBe(1);

    withDefaults(Base, { x: 1 });
    expect(CompositeRegistry.size).toBe(1);
  });

  test("expandComposite works identically on defaulted composites", () => {
    const Base = Composite<{ name: string; timeout: number }>((props) => ({
      fn: mockDeclarable(`Fn-${props.name}`),
      role: mockDeclarable(`Role-${props.name}`),
    }));

    const Wrapped = withDefaults(Base, { timeout: 30 });
    const expanded = expandComposite("api", Wrapped({ name: "test" }));

    expect(expanded.size).toBe(2);
    expect(expanded.get("api_fn")?.entityType).toBe("Fn-test");
    expect(expanded.get("api_role")?.entityType).toBe("Role-test");
  });
});

describe("propagate", () => {
  beforeEach(() => {
    CompositeRegistry.clear();
  });

  test("shared props appear on all expanded members", () => {
    const MyComp = Composite<{}>(() => ({
      bucket: mockDeclarableWithProps("Bucket", { bucketName: "data" }),
      role: mockDeclarableWithProps("Role", { roleName: "admin" }),
    }));

    const instance = propagate(MyComp({}), { env: "prod" });
    const expanded = expandComposite("s", instance);

    const bucketProps = (expanded.get("s_bucket") as any).props;
    const roleProps = (expanded.get("s_role") as any).props;
    expect(bucketProps.env).toBe("prod");
    expect(roleProps.env).toBe("prod");
  });

  test("array merge: member tags + shared tags are concatenated", () => {
    const MyComp = Composite<{}>(() => ({
      bucket: mockDeclarableWithProps("Bucket", {
        tags: [{ key: "team", value: "alpha" }],
      }),
    }));

    const instance = propagate(MyComp({}), {
      tags: [{ key: "env", value: "prod" }],
    });
    const expanded = expandComposite("s", instance);
    const tags = (expanded.get("s_bucket") as any).props.tags;

    expect(tags).toEqual([
      { key: "env", value: "prod" },
      { key: "team", value: "alpha" },
    ]);
  });

  test("scalar: member-specific value wins over shared", () => {
    const MyComp = Composite<{}>(() => ({
      bucket: mockDeclarableWithProps("Bucket", { region: "us-west-2" }),
    }));

    const instance = propagate(MyComp({}), { region: "eu-west-1" });
    const expanded = expandComposite("s", instance);
    expect((expanded.get("s_bucket") as any).props.region).toBe("us-west-2");
  });

  test("undefined values in shared props are stripped", () => {
    const MyComp = Composite<{}>(() => ({
      bucket: mockDeclarableWithProps("Bucket", { name: "data" }),
    }));

    const instance = propagate(MyComp({}), { name: undefined, extra: "yes" });
    const expanded = expandComposite("s", instance);
    const props = (expanded.get("s_bucket") as any).props;
    expect(props.name).toBe("data");
    expect(props.extra).toBe("yes");
  });

  test("nested composites: shared props propagate into nested members", () => {
    const Inner = Composite<{}>(() => ({
      table: mockDeclarableWithProps("Table", { tableName: "items" }),
    }));

    const Outer = Composite<{}>(() => ({
      bucket: mockDeclarableWithProps("Bucket", { bucketName: "data" }),
      nested: Inner({}) as unknown as Declarable,
    }));

    const instance = propagate(Outer({}), { env: "prod" });
    const expanded = expandComposite("app", instance);

    expect((expanded.get("app_bucket") as any).props.env).toBe("prod");
    expect((expanded.get("app_nested_table") as any).props.env).toBe("prod");
  });

  test("expanded declarables are same object references", () => {
    const bucket = mockDeclarableWithProps("Bucket", { name: "data" });
    const MyComp = Composite<{}>(() => ({ bucket }));

    const instance = propagate(MyComp({}), { env: "prod" });
    const expanded = expandComposite("s", instance);
    expect(expanded.get("s_bucket")).toBe(bucket);
  });

  test("composites without propagate work unchanged", () => {
    const MyComp = Composite<{}>(() => ({
      bucket: mockDeclarableWithProps("Bucket", { name: "data" }),
    }));

    const expanded = expandComposite("s", MyComp({}));
    expect((expanded.get("s_bucket") as any).props.name).toBe("data");
  });
});
