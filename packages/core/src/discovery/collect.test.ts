import { describe, test, expect, beforeEach } from "bun:test";
import { collectEntities } from "./collect";
import { DECLARABLE_MARKER } from "../declarable";
import { DiscoveryError } from "../errors";
import { Composite, CompositeRegistry } from "../composite";
import { createMockEntity, expectToThrow } from "@intentius/chant-test-utils";

describe("collectEntities", () => {
  test("collects declarable entities from single module", () => {
    const entity1 = createMockEntity("test");

    const modules = [
      {
        file: "test.ts",
        exports: {
          entity1,
          notDeclarable: "value",
        },
      },
    ];

    const result = collectEntities(modules);
    expect(result.size).toBe(1);
    expect(result.get("entity1")).toBe(entity1);
  });

  test("collects declarable entities from multiple modules", () => {
    const entity1 = createMockEntity("type1");
    const entity2 = createMockEntity("type2");
    const entity3 = createMockEntity("type3");

    const modules = [
      {
        file: "file1.ts",
        exports: {
          entity1,
          helper: "function",
        },
      },
      {
        file: "file2.ts",
        exports: {
          entity2,
          entity3,
          util: 42,
        },
      },
    ];

    const result = collectEntities(modules);
    expect(result.size).toBe(3);
    expect(result.get("entity1")).toBe(entity1);
    expect(result.get("entity2")).toBe(entity2);
    expect(result.get("entity3")).toBe(entity3);
  });

  test("ignores non-declarable exports", () => {
    const entity = createMockEntity("test");

    const modules = [
      {
        file: "mixed.ts",
        exports: {
          entity,
          string: "value",
          number: 123,
          object: { key: "value" },
          array: [1, 2, 3],
          func: () => "test",
          nullValue: null,
          undefinedValue: undefined,
          boolValue: true,
        },
      },
    ];

    const result = collectEntities(modules);
    expect(result.size).toBe(1);
    expect(result.get("entity")).toBe(entity);
  });

  test("returns empty map when no declarables found", () => {
    const modules = [
      {
        file: "empty.ts",
        exports: {
          value1: "string",
          value2: 42,
          value3: { data: "object" },
        },
      },
    ];

    const result = collectEntities(modules);
    expect(result.size).toBe(0);
  });

  test("returns empty map when modules array is empty", () => {
    const result = collectEntities([]);
    expect(result.size).toBe(0);
  });

  test("throws DiscoveryError with type 'resolution' on duplicate export names", async () => {
    const entity1 = createMockEntity("type1");
    const entity2 = createMockEntity("type2");

    const modules = [
      {
        file: "file1.ts",
        exports: { myEntity: entity1 },
      },
      {
        file: "file2.ts",
        exports: { myEntity: entity2 },
      },
    ];

    await expectToThrow(
      () => collectEntities(modules),
      DiscoveryError,
      (error) => {
        expect(error.type).toBe("resolution");
        expect(error.file).toBe("file2.ts");
        expect(error.message).toContain("Duplicate");
        expect(error.message).toContain("myEntity");
      }
    );
  });

  test("throws DiscoveryError with detailed message for duplicates", async () => {
    const entity1 = createMockEntity("test");
    const entity2 = createMockEntity("test");

    const modules = [
      {
        file: "a.ts",
        exports: { duplicateName: entity1 },
      },
      {
        file: "b.ts",
        exports: { duplicateName: entity2 },
      },
    ];

    await expectToThrow(
      () => collectEntities(modules),
      DiscoveryError,
      (error) => {
        expect(error.type).toBe("resolution");
        expect(error.message).toBe('Duplicate export name "duplicateName" found');
      }
    );
  });

  test("allows same export name if not declarable in one module", () => {
    const entity = createMockEntity("test");

    const modules = [
      {
        file: "file1.ts",
        exports: { name: "not declarable" },
      },
      {
        file: "file2.ts",
        exports: { name: entity },
      },
    ];

    const result = collectEntities(modules);
    expect(result.size).toBe(1);
    expect(result.get("name")).toBe(entity);
  });

  test("preserves entity type information", () => {
    const entity1 = createMockEntity("parameter");
    const entity2 = createMockEntity("output");

    const modules = [
      {
        file: "test.ts",
        exports: { entity1, entity2 },
      },
    ];

    const result = collectEntities(modules);
    expect(result.get("entity1")?.entityType).toBe("parameter");
    expect(result.get("entity2")?.entityType).toBe("output");
  });

  test("correctly identifies objects without DECLARABLE_MARKER as non-declarable", () => {
    const fakeDeclarable = {
      entityType: "fake",
      // Missing DECLARABLE_MARKER
    };

    const modules = [
      {
        file: "test.ts",
        exports: { fakeDeclarable },
      },
    ];

    const result = collectEntities(modules);
    expect(result.size).toBe(0);
  });

  test("correctly identifies objects with wrong marker value as non-declarable", () => {
    const fakeDeclarable = {
      entityType: "fake",
      [DECLARABLE_MARKER]: false, // Wrong value
    };

    const modules = [
      {
        file: "test.ts",
        exports: { fakeDeclarable },
      },
    ];

    const result = collectEntities(modules);
    expect(result.size).toBe(0);
  });

  test("error serializes to JSON correctly", async () => {
    const modules = [
      {
        file: "first.ts",
        exports: { dup: createMockEntity("test") },
      },
      {
        file: "second.ts",
        exports: { dup: createMockEntity("test") },
      },
    ];

    const error = await expectToThrow(
      () => collectEntities(modules),
      DiscoveryError
    );

    const json = error.toJSON();
    expect(json.name).toBe("DiscoveryError");
    expect(json.file).toBe("second.ts");
    expect(json.type).toBe("resolution");
    expect(json.message).toBeDefined();
  });
});

describe("collectEntities with composites", () => {
  beforeEach(() => {
    CompositeRegistry.clear();
  });

  test("composite is expanded into individual entities", () => {
    const Comp = Composite(() => ({
      a: createMockEntity("TestA"),
      b: createMockEntity("TestB"),
    }));
    const instance = Comp({});

    const entities = collectEntities([
      { file: "test.ts", exports: { myComp: instance } },
    ]);

    expect(entities.has("myComp_a")).toBe(true);
    expect(entities.has("myComp_b")).toBe(true);
    expect(entities.has("myComp")).toBe(false);
  });
});
