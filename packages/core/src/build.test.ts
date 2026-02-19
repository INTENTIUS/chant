import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { build, partitionByLexicon, detectCrossLexiconRefs } from "./build";
import { output } from "./lexicon-output";
import { AttrRef } from "./attrref";
import type { Serializer } from "./serializer";
import type { Declarable } from "./declarable";
import { DECLARABLE_MARKER } from "./declarable";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("build", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-build-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("builds empty directory successfully", async () => {
    const mockSerializer: Serializer = {
      name: "test",
      rulePrefix: "TEST",
      serialize: (_entities) => "serialized output",
    };

    const result = await build(testDir, [mockSerializer]);

    expect(result.outputs.size).toBe(0);
    expect(result.entities.size).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("discovers and builds entities with single lexicon", async () => {
    // Create a test infrastructure file with a simple entity
    const infraFile = join(testDir, "test.infra.ts");
    await writeFile(
      infraFile,
      `
export const testEntity = {
  lexicon: "test",
  entityType: "TestEntity",
  [Symbol.for("chant.declarable")]: true,
};
      `
    );

    const mockSerializer: Serializer = {
      name: "test",
      rulePrefix: "TEST",
      serialize: (_entities) => "serialized output",
    };

    const result = await build(testDir, [mockSerializer]);

    expect(result.outputs.size).toBe(1);
    expect(result.outputs.get("test")).toBe("serialized output");
    expect(result.entities.size).toBe(1);
    expect(result.entities.has("testEntity")).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  test("handles discovery errors", async () => {
    // Create a test file with syntax error
    const infraFile = join(testDir, "broken.infra.ts");
    await writeFile(infraFile, "this is not valid typescript {{{");

    const mockSerializer: Serializer = {
      name: "test",
      rulePrefix: "TEST",
      serialize: (_entities) => "serialized output",
    };

    const result = await build(testDir, [mockSerializer]);

    expect(result.entities.size).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("handles circular dependencies", async () => {
    // Create test file with circular entity dependencies (not import cycles)
    await writeFile(
      join(testDir, "entities.ts"),
      `
export const entity1 = {
  lexicon: "test",
  entityType: "TestEntity",
  [Symbol.for("chant.declarable")]: true,
};

export const entity2 = {
  lexicon: "test",
  entityType: "TestEntity",
  [Symbol.for("chant.declarable")]: true,
  ref1: entity1,
};

// Create circular reference after declaration
entity1.ref2 = entity2;
      `
    );

    const mockSerializer: Serializer = {
      name: "test",
      rulePrefix: "TEST",
      serialize: (_entities) => "serialized output",
    };

    const result = await build(testDir, [mockSerializer]);

    expect(result.outputs.get("test")).toBe("serialized output");

    // Should have a BuildError for circular dependency detected by topological sort
    const hasCircularError = result.errors.some(
      (err) => err.name === "BuildError" && err.message.includes("Circular dependency")
    );
    expect(hasCircularError).toBe(true);
  });

  test("calls serializer.serialize()", async () => {
    let serializeCalled = false;

    const infraFile = join(testDir, "test.infra.ts");
    await writeFile(
      infraFile,
      `
export const testEntity = {
  lexicon: "test",
  entityType: "TestEntity",
  [Symbol.for("chant.declarable")]: true,
};
      `
    );

    const mockSerializer: Serializer = {
      name: "test",
      rulePrefix: "TEST",
      serialize: (_entities) => {
        serializeCalled = true;
        return "custom serialization";
      },
    };

    const result = await build(testDir, [mockSerializer]);

    expect(serializeCalled).toBe(true);
    expect(result.outputs.get("test")).toBe("custom serialization");
  });

  test("two-lexicon project produces two outputs", async () => {
    const infraFile = join(testDir, "multi.infra.ts");
    await writeFile(
      infraFile,
      `
export const alphaEntity = {
  lexicon: "alpha",
  entityType: "Bucket",
  [Symbol.for("chant.declarable")]: true,
};

export const betaEntity = {
  lexicon: "beta",
  entityType: "Storage",
  [Symbol.for("chant.declarable")]: true,
};
      `
    );

    const alphaSerializer: Serializer = {
      name: "alpha",
      rulePrefix: "ALPHA",
      serialize: (entities) => JSON.stringify({ alpha: Array.from(entities.keys()) }),
    };

    const betaSerializer: Serializer = {
      name: "beta",
      rulePrefix: "BETA",
      serialize: (entities) => JSON.stringify({ beta: Array.from(entities.keys()) }),
    };

    const result = await build(testDir, [alphaSerializer, betaSerializer]);

    expect(result.outputs.size).toBe(2);
    expect(result.outputs.has("alpha")).toBe(true);
    expect(result.outputs.has("beta")).toBe(true);

    const alphaOutput = JSON.parse(result.outputs.get("alpha")!);
    expect(alphaOutput.alpha).toContain("alphaEntity");

    const betaOutput = JSON.parse(result.outputs.get("beta")!);
    expect(betaOutput.beta).toContain("betaEntity");
  });

  test("warns when no serializer found for a lexicon", async () => {
    const infraFile = join(testDir, "test.infra.ts");
    await writeFile(
      infraFile,
      `
export const testEntity = {
  lexicon: "unknown",
  entityType: "TestEntity",
  [Symbol.for("chant.declarable")]: true,
};
      `
    );

    const result = await build(testDir, []);

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('No serializer found for lexicon "unknown"');
  });
});

describe("partitionByLexicon", () => {
  test("partitions entities by lexicon", () => {
    const entities = new Map<string, Declarable>([
      [
        "bucket",
        { lexicon: "alpha", entityType: "Bucket", [DECLARABLE_MARKER]: true } as Declarable,
      ],
      [
        "storage",
        { lexicon: "beta", entityType: "Storage", [DECLARABLE_MARKER]: true } as Declarable,
      ],
      [
        "handler",
        { lexicon: "alpha", entityType: "Function", [DECLARABLE_MARKER]: true } as Declarable,
      ],
    ]);

    const partitions = partitionByLexicon(entities);

    expect(partitions.size).toBe(2);
    expect(partitions.get("alpha")!.size).toBe(2);
    expect(partitions.get("beta")!.size).toBe(1);
    expect(partitions.get("alpha")!.has("bucket")).toBe(true);
    expect(partitions.get("alpha")!.has("handler")).toBe(true);
    expect(partitions.get("beta")!.has("storage")).toBe(true);
  });

  test("single lexicon produces one partition", () => {
    const entities = new Map<string, Declarable>([
      [
        "bucket",
        { lexicon: "alpha", entityType: "Bucket", [DECLARABLE_MARKER]: true } as Declarable,
      ],
      [
        "handler",
        { lexicon: "alpha", entityType: "Function", [DECLARABLE_MARKER]: true } as Declarable,
      ],
    ]);

    const partitions = partitionByLexicon(entities);

    expect(partitions.size).toBe(1);
    expect(partitions.get("alpha")!.size).toBe(2);
  });

  test("empty entities produces empty partitions", () => {
    const entities = new Map<string, Declarable>();
    const partitions = partitionByLexicon(entities);
    expect(partitions.size).toBe(0);
  });

  test("property-kind entities partition by their own lexicon", () => {
    const entities = new Map<string, Declarable>([
      [
        "bucket",
        { lexicon: "alpha", entityType: "Bucket", [DECLARABLE_MARKER]: true } as Declarable,
      ],
      [
        "bucketPolicy",
        {
          lexicon: "alpha",
          entityType: "BucketPolicy",
          kind: "property",
          [DECLARABLE_MARKER]: true,
        } as Declarable,
      ],
    ]);

    const partitions = partitionByLexicon(entities);

    expect(partitions.size).toBe(1);
    expect(partitions.get("alpha")!.size).toBe(2);
    expect(partitions.get("alpha")!.has("bucketPolicy")).toBe(true);
  });
});

describe("detectCrossLexiconRefs", () => {
  test("cross-lexicon AttrRef is auto-detected without explicit output()", () => {
    const alphaBucket = {
      lexicon: "alpha",
      entityType: "Alpha::Storage::Bucket",
      [DECLARABLE_MARKER]: true,
    } as Declarable;

    const bucketEndpoint = new AttrRef(alphaBucket, "Endpoint");

    const ghAction = {
      lexicon: "github",
      entityType: "Action",
      [DECLARABLE_MARKER]: true,
      props: { url: bucketEndpoint },
    } as unknown as Declarable;

    const entities = new Map<string, Declarable>([
      ["dataBucket", alphaBucket],
      ["deployAction", ghAction],
    ]);

    const detected = detectCrossLexiconRefs(entities);

    expect(detected).toHaveLength(1);
    expect(detected[0].sourceLexicon).toBe("alpha");
    expect(detected[0].sourceEntity).toBe("dataBucket");
    expect(detected[0].sourceAttribute).toBe("Endpoint");
    expect(detected[0].outputName).toBe("dataBucket_Endpoint");
  });

  test("explicit output() overrides auto-detected name", () => {
    const alphaBucket = {
      lexicon: "alpha",
      entityType: "Alpha::Storage::Bucket",
      [DECLARABLE_MARKER]: true,
    } as Declarable;

    const bucketArn = new AttrRef(alphaBucket, "Arn");
    const explicitOutput = output(bucketArn, "MyCustomArnName");

    const ghAction = {
      lexicon: "github",
      entityType: "Action",
      [DECLARABLE_MARKER]: true,
      props: { arn: bucketArn, out: explicitOutput },
    } as unknown as Declarable;

    const entities = new Map<string, Declarable>([
      ["dataBucket", alphaBucket],
      ["deployAction", ghAction],
    ]);

    // Auto-detect finds the cross-lexicon ref
    const autoDetected = detectCrossLexiconRefs(entities);
    expect(autoDetected).toHaveLength(1);
    expect(autoDetected[0].outputName).toBe("dataBucket_Arn");

    // But when collecting explicit outputs, the explicit one is found
    const { collectLexiconOutputs } = require("./build");
    const explicitOutputs = collectLexiconOutputs(entities);
    expect(explicitOutputs).toHaveLength(1);
    expect(explicitOutputs[0].outputName).toBe("MyCustomArnName");

    // Merge logic: explicit wins (same parent object + attribute)
    const explicitRefs = explicitOutputs.map((o: { _sourceParent: WeakRef<object>; sourceAttribute: string }) => ({
      parent: o._sourceParent.deref(),
      attribute: o.sourceAttribute,
    }));
    const merged = [
      ...explicitOutputs,
      ...autoDetected.filter((auto) => {
        const autoParent = auto._sourceParent.deref();
        return !explicitRefs.some(
          (e: { parent: object | undefined; attribute: string }) =>
            e.parent === autoParent && e.attribute === auto.sourceAttribute
        );
      }),
    ];

    expect(merged).toHaveLength(1);
    expect(merged[0].outputName).toBe("MyCustomArnName");
  });

  test("same-lexicon AttrRef is NOT auto-detected", () => {
    const alphaBucket = {
      lexicon: "alpha",
      entityType: "Alpha::Storage::Bucket",
      [DECLARABLE_MARKER]: true,
    } as Declarable;

    const bucketArn = new AttrRef(alphaBucket, "Arn");

    const alphaFunction = {
      lexicon: "alpha",
      entityType: "Alpha::Compute::Function",
      [DECLARABLE_MARKER]: true,
      props: { bucketArn },
    } as unknown as Declarable;

    const entities = new Map<string, Declarable>([
      ["dataBucket", alphaBucket],
      ["handler", alphaFunction],
    ]);

    const detected = detectCrossLexiconRefs(entities);
    expect(detected).toHaveLength(0);
  });

  test("deduplicates when same cross-lexicon ref appears in multiple entities", () => {
    const alphaBucket = {
      lexicon: "alpha",
      entityType: "Alpha::Storage::Bucket",
      [DECLARABLE_MARKER]: true,
    } as Declarable;

    const bucketEndpoint = new AttrRef(alphaBucket, "Endpoint");

    const ghAction1 = {
      lexicon: "github",
      entityType: "Action",
      [DECLARABLE_MARKER]: true,
      props: { url: bucketEndpoint },
    } as unknown as Declarable;

    const ghAction2 = {
      lexicon: "github",
      entityType: "Action",
      [DECLARABLE_MARKER]: true,
      props: { endpoint: bucketEndpoint },
    } as unknown as Declarable;

    const entities = new Map<string, Declarable>([
      ["dataBucket", alphaBucket],
      ["action1", ghAction1],
      ["action2", ghAction2],
    ]);

    const detected = detectCrossLexiconRefs(entities);
    expect(detected).toHaveLength(1);
    expect(detected[0].outputName).toBe("dataBucket_Endpoint");
  });
});
