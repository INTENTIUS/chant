import { describe, test, expect } from "bun:test";
import { resolveAttrRefs } from "./resolve";
import { AttrRef } from "../attrref";
import type { Declarable } from "../declarable";
import { DECLARABLE_MARKER } from "../declarable";
import { LOGICAL_NAME_SYMBOL, getLogicalName } from "../utils";

describe("resolveAttrRefs", () => {
  test("sets logical names on all entities", () => {
    const entity1: Declarable = {
      entityType: "Test1",
      [DECLARABLE_MARKER]: true,
    };

    const entity2: Declarable = {
      entityType: "Test2",
      [DECLARABLE_MARKER]: true,
    };

    const entities = new Map<string, Declarable>([
      ["MyEntity1", entity1],
      ["MyEntity2", entity2],
    ]);

    resolveAttrRefs(entities);

    expect(getLogicalName(entity1)).toBe("MyEntity1");
    expect(getLogicalName(entity2)).toBe("MyEntity2");
  });

  test("resolves AttrRef with parent in entities collection", () => {
    const parent: Declarable = {
      entityType: "Parent",
      [DECLARABLE_MARKER]: true,
    };

    const child: Declarable & { ref: AttrRef } = {
      entityType: "Child",
      [DECLARABLE_MARKER]: true,
      ref: new AttrRef(parent, "Arn"),
    };

    const entities = new Map<string, Declarable>([
      ["ParentResource", parent],
      ["ChildResource", child],
    ]);

    resolveAttrRefs(entities);

    // Verify the AttrRef can now serialize
    expect(child.ref.toJSON()).toEqual({
      __attrRef: { entity: "ParentResource", attribute: "Arn" },
    });
  });

  test("resolves multiple AttrRefs on same entity", () => {
    const parent: Declarable = {
      entityType: "Parent",
      [DECLARABLE_MARKER]: true,
    };

    const child: Declarable & { arn: AttrRef; name: AttrRef } = {
      entityType: "Child",
      [DECLARABLE_MARKER]: true,
      arn: new AttrRef(parent, "Arn"),
      name: new AttrRef(parent, "Name"),
    };

    const entities = new Map<string, Declarable>([
      ["ParentResource", parent],
      ["ChildResource", child],
    ]);

    resolveAttrRefs(entities);

    expect(child.arn.toJSON()).toEqual({
      __attrRef: { entity: "ParentResource", attribute: "Arn" },
    });
    expect(child.name.toJSON()).toEqual({
      __attrRef: { entity: "ParentResource", attribute: "Name" },
    });
  });

  test("resolves AttrRefs with different parents", () => {
    const parent1: Declarable = {
      entityType: "Parent1",
      [DECLARABLE_MARKER]: true,
    };

    const parent2: Declarable = {
      entityType: "Parent2",
      [DECLARABLE_MARKER]: true,
    };

    const child: Declarable & { ref1: AttrRef; ref2: AttrRef } = {
      entityType: "Child",
      [DECLARABLE_MARKER]: true,
      ref1: new AttrRef(parent1, "Arn"),
      ref2: new AttrRef(parent2, "Name"),
    };

    const entities = new Map<string, Declarable>([
      ["Parent1Resource", parent1],
      ["Parent2Resource", parent2],
      ["ChildResource", child],
    ]);

    resolveAttrRefs(entities);

    expect(child.ref1.toJSON()).toEqual({
      __attrRef: { entity: "Parent1Resource", attribute: "Arn" },
    });
    expect(child.ref2.toJSON()).toEqual({
      __attrRef: { entity: "Parent2Resource", attribute: "Name" },
    });
  });

  test("throws when AttrRef parent not in entities collection", () => {
    const parent = {}; // Not a Declarable, not in entities

    const child: Declarable & { ref: AttrRef } = {
      entityType: "Child",
      [DECLARABLE_MARKER]: true,
      ref: new AttrRef(parent, "Arn"),
    };

    const entities = new Map<string, Declarable>([["ChildResource", child]]);

    expect(() => resolveAttrRefs(entities)).toThrow(
      'Cannot resolve AttrRef on "ChildResource.ref": parent entity not found in entities collection'
    );
  });

  test("handles entities with no AttrRefs", () => {
    const entity1: Declarable = {
      entityType: "Test1",
      [DECLARABLE_MARKER]: true,
    };

    const entity2: Declarable & { prop: string } = {
      entityType: "Test2",
      [DECLARABLE_MARKER]: true,
      prop: "value",
    };

    const entities = new Map<string, Declarable>([
      ["Entity1", entity1],
      ["Entity2", entity2],
    ]);

    expect(() => resolveAttrRefs(entities)).not.toThrow();

    expect(getLogicalName(entity1)).toBe("Entity1");
    expect(getLogicalName(entity2)).toBe("Entity2");
  });

  test("handles empty entities map", () => {
    const entities = new Map<string, Declarable>();

    expect(() => resolveAttrRefs(entities)).not.toThrow();
  });

  test("resolves chain of entities with AttrRefs", () => {
    const root: Declarable = {
      entityType: "Root",
      [DECLARABLE_MARKER]: true,
    };

    const middle: Declarable & { rootRef: AttrRef } = {
      entityType: "Middle",
      [DECLARABLE_MARKER]: true,
      rootRef: new AttrRef(root, "Id"),
    };

    const leaf: Declarable & { middleRef: AttrRef } = {
      entityType: "Leaf",
      [DECLARABLE_MARKER]: true,
      middleRef: new AttrRef(middle, "Name"),
    };

    const entities = new Map<string, Declarable>([
      ["RootResource", root],
      ["MiddleResource", middle],
      ["LeafResource", leaf],
    ]);

    resolveAttrRefs(entities);

    expect(middle.rootRef.toJSON()).toEqual({
      __attrRef: { entity: "RootResource", attribute: "Id" },
    });
    expect(leaf.middleRef.toJSON()).toEqual({
      __attrRef: { entity: "MiddleResource", attribute: "Name" },
    });
  });

  test("handles entity referencing itself", () => {
    const entity: Declarable & { selfRef: AttrRef } = {
      entityType: "SelfReferencing",
      [DECLARABLE_MARKER]: true,
      selfRef: null as unknown as AttrRef, // Will be set below
    };

    entity.selfRef = new AttrRef(entity, "Arn");

    const entities = new Map<string, Declarable>([["MyResource", entity]]);

    resolveAttrRefs(entities);

    expect(entity.selfRef.toJSON()).toEqual({
      __attrRef: { entity: "MyResource", attribute: "Arn" },
    });
  });

  test("preserves logical name symbol on entities", () => {
    const entity: Declarable = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
    };

    const entities = new Map<string, Declarable>([["TestResource", entity]]);

    resolveAttrRefs(entities);

    const entityWithSymbol = entity as unknown as Record<symbol, unknown>;
    expect(entityWithSymbol[LOGICAL_NAME_SYMBOL]).toBe("TestResource");
  });

  test("uses export name as logical name", () => {
    const entity: Declarable = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
    };

    const entities = new Map<string, Declarable>([
      ["MyCustomExportName", entity],
    ]);

    resolveAttrRefs(entities);

    expect(getLogicalName(entity)).toBe("MyCustomExportName");
  });

  test("handles complex attribute names in AttrRef", () => {
    const parent: Declarable = {
      entityType: "Parent",
      [DECLARABLE_MARKER]: true,
    };

    const child: Declarable & { ref: AttrRef } = {
      entityType: "Child",
      [DECLARABLE_MARKER]: true,
      ref: new AttrRef(parent, "Outputs.WebsiteURL"),
    };

    const entities = new Map<string, Declarable>([
      ["ParentResource", parent],
      ["ChildResource", child],
    ]);

    resolveAttrRefs(entities);

    expect(child.ref.toJSON()).toEqual({
      __attrRef: { entity: "ParentResource", attribute: "Outputs.WebsiteURL" },
    });
  });
});
