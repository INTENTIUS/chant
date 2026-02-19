import { describe, test, expect } from "bun:test";
import { buildDependencyGraph } from "./graph";
import { DECLARABLE_MARKER, type Declarable } from "../declarable";
import { AttrRef } from "../attrref";

describe("buildDependencyGraph", () => {
  test("returns empty graph for empty entities map", () => {
    const entities = new Map<string, Declarable>();
    const graph = buildDependencyGraph(entities);
    expect(graph.size).toBe(0);
  });

  test("returns graph with no dependencies for single entity", () => {
    const entity: Declarable = {
      entityType: "test",
      [DECLARABLE_MARKER]: true,
    };

    const entities = new Map([["Entity1", entity]]);
    const graph = buildDependencyGraph(entities);

    expect(graph.size).toBe(1);
    expect(graph.get("Entity1")?.size).toBe(0);
  });

  test("returns graph with no dependencies for multiple unrelated entities", () => {
    const entity1: Declarable = {
      entityType: "test",
      [DECLARABLE_MARKER]: true,
    };

    const entity2: Declarable = {
      entityType: "test",
      [DECLARABLE_MARKER]: true,
    };

    const entities = new Map([
      ["Entity1", entity1],
      ["Entity2", entity2],
    ]);
    const graph = buildDependencyGraph(entities);

    expect(graph.size).toBe(2);
    expect(graph.get("Entity1")?.size).toBe(0);
    expect(graph.get("Entity2")?.size).toBe(0);
  });

  test("detects dependency from AttrRef", () => {
    const parent: Declarable = {
      entityType: "parent",
      [DECLARABLE_MARKER]: true,
    };

    const child: Declarable & { ref: AttrRef } = {
      entityType: "child",
      [DECLARABLE_MARKER]: true,
      ref: new AttrRef(parent, "someAttr"),
    };

    const entities = new Map([
      ["Parent", parent],
      ["Child", child],
    ]);
    const graph = buildDependencyGraph(entities);

    expect(graph.size).toBe(2);
    expect(graph.get("Parent")?.size).toBe(0);
    expect(graph.get("Child")?.has("Parent")).toBe(true);
    expect(graph.get("Child")?.size).toBe(1);
  });

  test("detects dependency from direct Declarable reference", () => {
    const entity1: Declarable = {
      entityType: "type1",
      [DECLARABLE_MARKER]: true,
    };

    const entity2: Declarable & { dependency: Declarable } = {
      entityType: "type2",
      [DECLARABLE_MARKER]: true,
      dependency: entity1,
    };

    const entities = new Map([
      ["Entity1", entity1],
      ["Entity2", entity2],
    ]);
    const graph = buildDependencyGraph(entities);

    expect(graph.size).toBe(2);
    expect(graph.get("Entity1")?.size).toBe(0);
    expect(graph.get("Entity2")?.has("Entity1")).toBe(true);
    expect(graph.get("Entity2")?.size).toBe(1);
  });

  test("detects multiple dependencies from one entity", () => {
    const entity1: Declarable = {
      entityType: "type1",
      [DECLARABLE_MARKER]: true,
    };

    const entity2: Declarable = {
      entityType: "type2",
      [DECLARABLE_MARKER]: true,
    };

    const entity3: Declarable & { dep1: Declarable; dep2: Declarable } = {
      entityType: "type3",
      [DECLARABLE_MARKER]: true,
      dep1: entity1,
      dep2: entity2,
    };

    const entities = new Map([
      ["Entity1", entity1],
      ["Entity2", entity2],
      ["Entity3", entity3],
    ]);
    const graph = buildDependencyGraph(entities);

    expect(graph.size).toBe(3);
    expect(graph.get("Entity3")?.has("Entity1")).toBe(true);
    expect(graph.get("Entity3")?.has("Entity2")).toBe(true);
    expect(graph.get("Entity3")?.size).toBe(2);
  });

  test("detects dependencies in nested objects", () => {
    const entity1: Declarable = {
      entityType: "type1",
      [DECLARABLE_MARKER]: true,
    };

    const entity2: Declarable & { nested: { deep: Declarable } } = {
      entityType: "type2",
      [DECLARABLE_MARKER]: true,
      nested: {
        deep: entity1,
      },
    };

    const entities = new Map([
      ["Entity1", entity1],
      ["Entity2", entity2],
    ]);
    const graph = buildDependencyGraph(entities);

    expect(graph.get("Entity2")?.has("Entity1")).toBe(true);
    expect(graph.get("Entity2")?.size).toBe(1);
  });

  test("detects dependencies in arrays", () => {
    const entity1: Declarable = {
      entityType: "type1",
      [DECLARABLE_MARKER]: true,
    };

    const entity2: Declarable = {
      entityType: "type2",
      [DECLARABLE_MARKER]: true,
    };

    const entity3: Declarable & { deps: Declarable[] } = {
      entityType: "type3",
      [DECLARABLE_MARKER]: true,
      deps: [entity1, entity2],
    };

    const entities = new Map([
      ["Entity1", entity1],
      ["Entity2", entity2],
      ["Entity3", entity3],
    ]);
    const graph = buildDependencyGraph(entities);

    expect(graph.get("Entity3")?.has("Entity1")).toBe(true);
    expect(graph.get("Entity3")?.has("Entity2")).toBe(true);
    expect(graph.get("Entity3")?.size).toBe(2);
  });

  test("detects mixed AttrRef and Declarable dependencies", () => {
    const entity1: Declarable = {
      entityType: "type1",
      [DECLARABLE_MARKER]: true,
    };

    const entity2: Declarable = {
      entityType: "type2",
      [DECLARABLE_MARKER]: true,
    };

    const entity3: Declarable & { ref: AttrRef; dep: Declarable } = {
      entityType: "type3",
      [DECLARABLE_MARKER]: true,
      ref: new AttrRef(entity1, "attr"),
      dep: entity2,
    };

    const entities = new Map([
      ["Entity1", entity1],
      ["Entity2", entity2],
      ["Entity3", entity3],
    ]);
    const graph = buildDependencyGraph(entities);

    expect(graph.get("Entity3")?.has("Entity1")).toBe(true);
    expect(graph.get("Entity3")?.has("Entity2")).toBe(true);
    expect(graph.get("Entity3")?.size).toBe(2);
  });

  test("handles transitive dependencies correctly", () => {
    const entity1: Declarable = {
      entityType: "type1",
      [DECLARABLE_MARKER]: true,
    };

    const entity2: Declarable & { dep: Declarable } = {
      entityType: "type2",
      [DECLARABLE_MARKER]: true,
      dep: entity1,
    };

    const entity3: Declarable & { dep: Declarable } = {
      entityType: "type3",
      [DECLARABLE_MARKER]: true,
      dep: entity2,
    };

    const entities = new Map([
      ["Entity1", entity1],
      ["Entity2", entity2],
      ["Entity3", entity3],
    ]);
    const graph = buildDependencyGraph(entities);

    expect(graph.get("Entity1")?.size).toBe(0);
    expect(graph.get("Entity2")?.has("Entity1")).toBe(true);
    expect(graph.get("Entity2")?.size).toBe(1);
    expect(graph.get("Entity3")?.has("Entity2")).toBe(true);
    expect(graph.get("Entity3")?.size).toBe(1);
  });

  test("ignores non-entity declarables", () => {
    const entity: Declarable = {
      entityType: "test",
      [DECLARABLE_MARKER]: true,
    };

    const notInEntities: Declarable = {
      entityType: "external",
      [DECLARABLE_MARKER]: true,
    };

    const entityWithExternal: Declarable & { dep: Declarable } = {
      entityType: "test",
      [DECLARABLE_MARKER]: true,
      dep: notInEntities,
    };

    const entities = new Map([
      ["Entity", entity],
      ["EntityWithExternal", entityWithExternal],
    ]);
    const graph = buildDependencyGraph(entities);

    expect(graph.get("EntityWithExternal")?.size).toBe(0);
  });

  test("ignores AttrRef with parent not in entities", () => {
    const externalParent: Declarable = {
      entityType: "external",
      [DECLARABLE_MARKER]: true,
    };

    const entity: Declarable & { ref: AttrRef } = {
      entityType: "test",
      [DECLARABLE_MARKER]: true,
      ref: new AttrRef(externalParent, "attr"),
    };

    const entities = new Map([["Entity", entity]]);
    const graph = buildDependencyGraph(entities);

    expect(graph.get("Entity")?.size).toBe(0);
  });

  test("handles circular references without infinite loop", () => {
    const entity1: Declarable & { other?: Declarable } = {
      entityType: "type1",
      [DECLARABLE_MARKER]: true,
    };

    const entity2: Declarable & { other: Declarable } = {
      entityType: "type2",
      [DECLARABLE_MARKER]: true,
      other: entity1,
    };

    entity1.other = entity2;

    const entities = new Map([
      ["Entity1", entity1],
      ["Entity2", entity2],
    ]);
    const graph = buildDependencyGraph(entities);

    expect(graph.get("Entity1")?.has("Entity2")).toBe(true);
    expect(graph.get("Entity2")?.has("Entity1")).toBe(true);
  });

  test("handles self-reference without infinite loop", () => {
    const entity: Declarable & { self?: Declarable } = {
      entityType: "test",
      [DECLARABLE_MARKER]: true,
    };

    entity.self = entity;

    const entities = new Map([["Entity", entity]]);
    const graph = buildDependencyGraph(entities);

    expect(graph.get("Entity")?.has("Entity")).toBe(true);
    expect(graph.get("Entity")?.size).toBe(1);
  });

  test("ignores primitive values", () => {
    const entity: Declarable & {
      str: string;
      num: number;
      bool: boolean;
      nul: null;
    } = {
      entityType: "test",
      [DECLARABLE_MARKER]: true,
      str: "value",
      num: 42,
      bool: true,
      nul: null,
    };

    const entities = new Map([["Entity", entity]]);
    const graph = buildDependencyGraph(entities);

    expect(graph.get("Entity")?.size).toBe(0);
  });

  test("self-referencing AttrRefs do not create self-dependency", () => {
    // Mirrors createResource: each resource has AttrRef properties whose
    // parent is the resource itself (e.g. bucket.arn, bucket.bucketName).
    // These are not real dependencies — they're just attribute accessors.
    const resource: Declarable & { arn?: AttrRef; bucketName?: AttrRef } = {
      entityType: "AWS::S3::Bucket",
      [DECLARABLE_MARKER]: true,
    };
    resource.arn = new AttrRef(resource, "Arn");
    resource.bucketName = new AttrRef(resource, "BucketName");

    const entities = new Map([["myBucket", resource]]);
    const graph = buildDependencyGraph(entities);

    expect(graph.get("myBucket")?.size).toBe(0);
  });

  test("self-referencing AttrRefs do not mask real cross-resource deps", () => {
    // A resource has its own AttrRefs (self-pointing) AND a property that
    // references a different entity. Only the cross-resource dep should appear.
    const defaults: Declarable = {
      entityType: "AWS::S3::VersioningConfiguration",
      [DECLARABLE_MARKER]: true,
    };

    const bucket: Declarable & {
      arn?: AttrRef;
      versioningConfiguration?: Declarable;
    } = {
      entityType: "AWS::S3::Bucket",
      [DECLARABLE_MARKER]: true,
    };
    bucket.arn = new AttrRef(bucket, "Arn");
    bucket.versioningConfiguration = defaults;

    const entities = new Map([
      ["defaults", defaults],
      ["myBucket", bucket],
    ]);
    const graph = buildDependencyGraph(entities);

    expect(graph.get("myBucket")?.has("defaults")).toBe(true);
    expect(graph.get("myBucket")?.has("myBucket")).toBe(false);
    expect(graph.get("myBucket")?.size).toBe(1);
  });

  test("ignores plain objects without markers", () => {
    const entity: Declarable & { data: { key: string } } = {
      entityType: "test",
      [DECLARABLE_MARKER]: true,
      data: { key: "value" },
    };

    const entities = new Map([["Entity", entity]]);
    const graph = buildDependencyGraph(entities);

    expect(graph.get("Entity")?.size).toBe(0);
  });

  test("handles AttrRef with garbage collected parent gracefully", () => {
    const entity: Declarable & { ref: AttrRef } = {
      entityType: "test",
      [DECLARABLE_MARKER]: true,
      ref: new AttrRef({}, "attr"), // Using plain object that will be GC'd
    };

    const entities = new Map([["Entity", entity]]);
    const graph = buildDependencyGraph(entities);

    // Should not crash and should have no dependencies
    expect(graph.get("Entity")?.size).toBe(0);
  });

  test("detects dependencies deeply nested in arrays and objects", () => {
    const entity1: Declarable = {
      entityType: "type1",
      [DECLARABLE_MARKER]: true,
    };

    const entity2: Declarable & {
      complex: { nested: { array: Array<{ item: Declarable }> } };
    } = {
      entityType: "type2",
      [DECLARABLE_MARKER]: true,
      complex: {
        nested: {
          array: [{ item: entity1 }],
        },
      },
    };

    const entities = new Map([
      ["Entity1", entity1],
      ["Entity2", entity2],
    ]);
    const graph = buildDependencyGraph(entities);

    expect(graph.get("Entity2")?.has("Entity1")).toBe(true);
    expect(graph.get("Entity2")?.size).toBe(1);
  });

  test("does not traverse into referenced declarables", () => {
    const entity1: Declarable = {
      entityType: "type1",
      [DECLARABLE_MARKER]: true,
    };

    const entity2: Declarable & { internal: { data: string } } = {
      entityType: "type2",
      [DECLARABLE_MARKER]: true,
      internal: { data: "should not traverse this" },
    };

    const entity3: Declarable & { dep: Declarable } = {
      entityType: "type3",
      [DECLARABLE_MARKER]: true,
      dep: entity2,
    };

    const entities = new Map([
      ["Entity1", entity1],
      ["Entity2", entity2],
      ["Entity3", entity3],
    ]);
    const graph = buildDependencyGraph(entities);

    // Entity3 should only depend on Entity2, not traverse into Entity2's properties
    expect(graph.get("Entity3")?.has("Entity2")).toBe(true);
    expect(graph.get("Entity3")?.size).toBe(1);
  });
});
