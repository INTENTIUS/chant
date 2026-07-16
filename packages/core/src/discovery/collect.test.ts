import { describe, test, expect, beforeEach } from "vitest";
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

  test("collects arrays of declarable entities with indexed names", () => {
    const e0 = createMockEntity("type");
    const e1 = createMockEntity("type");
    const e2 = createMockEntity("type");

    const modules = [
      {
        file: "test.ts",
        exports: { myResources: [e0, e1, e2] },
      },
    ];

    const result = collectEntities(modules);
    expect(result.size).toBe(3);
    expect(result.get("myResources_0")).toBe(e0);
    expect(result.get("myResources_1")).toBe(e1);
    expect(result.get("myResources_2")).toBe(e2);
  });

  test("ignores non-declarable items within arrays", () => {
    const e0 = createMockEntity("type");

    const modules = [
      {
        file: "test.ts",
        exports: { mixed: [e0, "string", 42, null] },
      },
    ];

    const result = collectEntities(modules);
    expect(result.size).toBe(1);
    expect(result.get("mixed_0")).toBe(e0);
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

// #932 — a multi-stack project (independently-deployed sibling stacks under one
// root) legitimately reuses conventional cross-stack Parameter names across
// siblings. The unscoped whole-project build must namespace by directory instead
// of throwing, while a per-stack scoped build keeps the raw (deployed) names.
describe("collectEntities — cross-directory namespaces (#932)", () => {
  test("the same bare name in two different directories is disambiguated by a stack prefix, not thrown", () => {
    const agentsBucket = createMockEntity("param");
    const backendBucket = createMockEntity("param");

    const result = collectEntities(
      [
        { file: "src/loom-agents/params.ts", exports: { pArtifactBucket: agentsBucket } },
        { file: "src/loom-backend/params.ts", exports: { pArtifactBucket: backendBucket } },
      ],
      "src",
    );

    expect(result.size).toBe(2);
    expect(result.get("LoomAgentspArtifactBucket")).toBe(agentsBucket);
    expect(result.get("LoomBackendpArtifactBucket")).toBe(backendBucket);
    // The raw name is not used when it collides across directories.
    expect(result.has("pArtifactBucket")).toBe(false);
    // Disambiguated keys stay within CloudFormation's logical-id grammar.
    for (const key of result.keys()) expect(key).toMatch(/^[A-Za-z0-9]+$/);
  });

  test("a genuine same-directory duplicate still throws", async () => {
    const a = createMockEntity("param");
    const b = createMockEntity("param");

    await expectToThrow(
      () =>
        collectEntities(
          [
            { file: "src/loom-backend/params.ts", exports: { pArtifactBucket: a } },
            { file: "src/loom-backend/more.ts", exports: { pArtifactBucket: b } },
          ],
          "src",
        ),
      DiscoveryError,
      (error) => {
        expect(error.type).toBe("resolution");
        expect(error.message).toBe('Duplicate export name "pArtifactBucket" found');
      },
    );
  });

  test("the same object re-exported from two directories stays one raw-named entity", () => {
    const shared = createMockEntity("param");

    const result = collectEntities(
      [
        { file: "src/a/x.ts", exports: { shared } },
        { file: "src/b/y.ts", exports: { shared } },
      ],
      "src",
    );

    expect(result.size).toBe(1);
    expect(result.get("shared")).toBe(shared);
  });

  test("non-colliding names in different directories keep their raw names (single-stack subdirs unaffected)", () => {
    const vpc = createMockEntity("resource");
    const app = createMockEntity("resource");

    const result = collectEntities(
      [
        { file: "src/network/vpc.ts", exports: { vpc } },
        { file: "src/compute/app.ts", exports: { app } },
      ],
      "src",
    );

    expect(result.size).toBe(2);
    expect(result.get("vpc")).toBe(vpc);
    expect(result.get("app")).toBe(app);
  });

  test("a scoped per-stack build (buildRoot == the stack dir) keeps raw names — deploy fidelity", () => {
    const bucket = createMockEntity("param");

    const result = collectEntities(
      [{ file: "src/loom-backend/params.ts", exports: { pArtifactBucket: bucket } }],
      "src/loom-backend",
    );

    expect(result.get("pArtifactBucket")).toBe(bucket);
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

    expect(entities.has("myCompA")).toBe(true);
    expect(entities.has("myCompB")).toBe(true);
    expect(entities.has("myComp")).toBe(false);
  });
});

describe("collectEntities — default exports (op files)", () => {
  test("two files with `export default` do not collide (keyed per file)", () => {
    const apply = createMockEntity("Temporal::Op");
    const reconcile = createMockEntity("Temporal::Op");
    const result = collectEntities([
      { file: "ops/apply.op.ts", exports: { default: apply } },
      { file: "ops/reconcile.op.ts", exports: { default: reconcile } },
    ]);
    expect(result.size).toBe(2);
    // keyed by file basename (sans .op.ts), not the literal "default"
    expect(result.get("apply")).toBe(apply);
    expect(result.get("reconcile")).toBe(reconcile);
    expect(result.has("default")).toBe(false);
  });

  test("a single default export is collected (not dropped)", () => {
    const op = createMockEntity("Temporal::Op");
    const result = collectEntities([{ file: "ops/deploy.op.ts", exports: { default: op } }]);
    expect(result.get("deploy")).toBe(op);
  });
});
