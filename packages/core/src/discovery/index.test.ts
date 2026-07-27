import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { discover } from "./index";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DECLARABLE_MARKER } from "../declarable";

describe("discover", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-discover-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("returns empty result for empty directory", async () => {
    const result = await discover(testDir);

    expect(result.entities.size).toBe(0);
    expect(result.dependencies.size).toBe(0);
    expect(result.sourceFiles).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("discovers entities from a single file", async () => {
    await writeFile(
      join(testDir, "app.ts"),
      `
        export const myEntity = {
          entityType: "TestEntity",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(1);
    expect(result.entities.has("myEntity")).toBe(true);
    expect(result.sourceFiles).toHaveLength(1);
    expect(result.sourceFiles[0]).toMatch(/app\.ts$/);
    expect(result.errors).toEqual([]);
  });

  test("discovers entities from multiple files", async () => {
    await writeFile(
      join(testDir, "app.ts"),
      `
        export const entity1 = {
          entityType: "Entity1",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    await writeFile(
      join(testDir, "config.ts"),
      `
        export const entity2 = {
          entityType: "Entity2",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(2);
    expect(result.entities.has("entity1")).toBe(true);
    expect(result.entities.has("entity2")).toBe(true);
    expect(result.sourceFiles).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  test("builds dependency graph for entities with references", async () => {
    await writeFile(
      join(testDir, "entities.ts"),
      `
        export const parent = {
          entityType: "Parent",
          [Symbol.for("chant.declarable")]: true,
        };

        export const child = {
          entityType: "Child",
          [Symbol.for("chant.declarable")]: true,
          parentRef: parent,
        };
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(2);
    expect(result.dependencies.size).toBe(2);

    const childDeps = result.dependencies.get("child");
    expect(childDeps).toBeDefined();
    expect(childDeps?.has("parent")).toBe(true);

    const parentDeps = result.dependencies.get("parent");
    expect(parentDeps).toBeDefined();
    expect(parentDeps?.size).toBe(0);

    expect(result.errors).toEqual([]);
  });

  test("collects import errors and continues processing", async () => {
    await writeFile(
      join(testDir, "good.ts"),
      `
        export const goodEntity = {
          entityType: "Good",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    await writeFile(
      join(testDir, "bad.ts"),
      `
        // This will cause a syntax error
        export const badEntity = {
          entityType: "Bad"
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    const result = await discover(testDir);

    // Should still process the good file
    expect(result.entities.has("goodEntity")).toBe(true);
    expect(result.sourceFiles).toHaveLength(2);

    // Should have collected the import error
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.type === "import")).toBe(true);
  });

  test("returns source files even when no entities found", async () => {
    await writeFile(
      join(testDir, "empty.ts"),
      `
        export const notAnEntity = { foo: "bar" };
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(0);
    expect(result.sourceFiles).toHaveLength(1);
    expect(result.sourceFiles[0]).toMatch(/empty\.ts$/);
    expect(result.errors).toEqual([]);
  });

  test("handles nested directory structures", async () => {
    const subDir = join(testDir, "src", "entities");
    await mkdir(subDir, { recursive: true });

    await writeFile(
      join(testDir, "root.ts"),
      `
        export const rootEntity = {
          entityType: "Root",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    await writeFile(
      join(subDir, "nested.ts"),
      `
        export const nestedEntity = {
          entityType: "Nested",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(2);
    expect(result.entities.has("rootEntity")).toBe(true);
    expect(result.entities.has("nestedEntity")).toBe(true);
    expect(result.sourceFiles).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  test("excludes test files from discovery", async () => {
    await writeFile(
      join(testDir, "app.ts"),
      `
        export const appEntity = {
          entityType: "App",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    await writeFile(
      join(testDir, "app.test.ts"),
      `
        export const testEntity = {
          entityType: "Test",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(1);
    expect(result.entities.has("appEntity")).toBe(true);
    expect(result.entities.has("testEntity")).toBe(false);
    expect(result.sourceFiles).toHaveLength(1);
  });

  test("filters non-declarable exports", async () => {
    await writeFile(
      join(testDir, "mixed.ts"),
      `
        export const entity = {
          entityType: "Entity",
          [Symbol.for("chant.declarable")]: true,
        };

        export const nonEntity = { foo: "bar" };
        export const anotherNonEntity = 42;
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(1);
    expect(result.entities.has("entity")).toBe(true);
    expect(result.entities.has("nonEntity")).toBe(false);
    expect(result.entities.has("anotherNonEntity")).toBe(false);
  });

  test("returns empty dependencies map for entities without references", async () => {
    await writeFile(
      join(testDir, "standalone.ts"),
      `
        export const standalone1 = {
          entityType: "Standalone1",
          [Symbol.for("chant.declarable")]: true,
        };

        export const standalone2 = {
          entityType: "Standalone2",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(2);
    expect(result.dependencies.size).toBe(2);

    const deps1 = result.dependencies.get("standalone1");
    expect(deps1?.size).toBe(0);

    const deps2 = result.dependencies.get("standalone2");
    expect(deps2?.size).toBe(0);
  });
});

describe("discover — fold mode (#1022, epic #1019)", () => {
  let testDir: string;
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const runtimePath = resolve(thisDir, "../runtime");
  const compositePath = resolve(thisDir, "../composite");
  const lexiconOutputPath = resolve(thisDir, "../lexicon-output");
  const stackOutputPath = resolve(thisDir, "../stack-output");

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-discover-fold-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("default (flag omitted) leaves foldDecisions empty and behavior unchanged", async () => {
    await writeFile(
      join(testDir, "app.ts"),
      `
        export const entity = {
          entityType: "Entity",
          [Symbol.for("chant.declarable")]: true,
        };
      `,
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(1);
    expect(result.foldDecisions).toEqual([]);
  });

  test("folds a leaf-only module with zero execution (throw sentinel never fires)", async () => {
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
    await writeFile(
      join(testDir, "main.ts"),
      `
        import { Bucket } from "./resources";
        throw new Error("must never execute — sentinel for #1022 fold verification");
        export const bucket = new Bucket({ name: "my-bucket" });
      `,
    );

    // Sanity check: running this directory the normal way really does fire
    // the sentinel (a collected import error), proving fold isn't just
    // accidentally skipping a no-op file.
    const ran = await discover(testDir);
    expect(ran.errors.some((e) => e.message.includes("must never execute"))).toBe(true);

    const result = await discover(testDir, { fold: true });

    expect(result.errors).toEqual([]);
    expect(result.entities.size).toBe(1);
    expect(result.entities.has("bucket")).toBe(true);
    const bucket = result.entities.get("bucket")!;
    expect((bucket as unknown as { lexicon: string }).lexicon).toBe("aws");
    expect((bucket as unknown as { entityType: string }).entityType).toBe("Test::Bucket");

    expect(result.foldDecisions).toHaveLength(2);
    const mainDecision = result.foldDecisions.find((d) => d.file.endsWith("main.ts"));
    expect(mainDecision?.mode).toBe("fold");
    expect(mainDecision?.resourceCount).toBe(1);
  });

  // chant #1023 (epic #1019 Phase 5): a bare composite factory call now
  // folds too — the factory is resolved through the file's imports and
  // invoked for real with statically-folded props, exactly as a resource
  // constructor already was (#1022). Fold and run must still agree
  // byte-for-byte on the expanded entities (this is the unit-level version
  // of the #1025 fold-vs-run differential).
  test("a module instantiating a composite folds too; output is unchanged", async () => {
    await writeFile(
      join(testDir, "composites.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        import { Composite } from ${JSON.stringify(compositePath)};
        const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
        export const MyStack = Composite<{ name: string }>((props) => {
          const bucket = new Bucket({ name: props.name });
          return { bucket };
        }, "MyStack");
      `,
    );
    await writeFile(
      join(testDir, "stack.ts"),
      `
        import { MyStack } from "./composites";
        export const stack = MyStack({ name: "composite-bucket" });
      `,
    );

    const withoutFold = await discover(testDir);
    const withFold = await discover(testDir, { fold: true });

    expect(withFold.errors).toEqual([]);
    expect(withFold.entities.size).toBe(withoutFold.entities.size);
    expect([...withFold.entities.keys()].sort()).toEqual([...withoutFold.entities.keys()].sort());
    expect(withFold.entities.has("stackBucket")).toBe(true);
    const folded = withFold.entities.get("stackBucket")! as unknown as { props: { name: string } };
    const run = withoutFold.entities.get("stackBucket")! as unknown as { props: { name: string } };
    expect(folded.props).toEqual(run.props);

    const stackDecision = withFold.foldDecisions.find((d) => d.file.endsWith("stack.ts"));
    expect(stackDecision?.mode).toBe("fold");
    expect(stackDecision?.resourceCount).toBe(1);
  });

  // chant #1112 — a folded file's `output(...)` used to be resolved and then
  // thrown away: the fold path handed discovery only the Declarable/
  // CompositeInstance exports it had picked out itself, and a `LexiconOutput`
  // is neither. `build()` never saw it, and the template lost its whole
  // Outputs section with no warning and exit 0. Discovery now hands
  // `collectEntities` the file's WHOLE folded export namespace, so both paths
  // filter exports through the same code.
  test("a folded file's output(...) export reaches the entities map, exactly as running it does", async () => {
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
    await writeFile(
      join(testDir, "main.ts"),
      `
        import { Bucket } from "./resources";
        export const bucket = new Bucket({ name: "my-bucket" });
      `,
    );
    // Cross-file, which is what real projects do (a dedicated outputs.ts) and
    // what makes the ref resolve to a genuine live AttrRef, so the file folds.
    await writeFile(
      join(testDir, "outputs.ts"),
      `
        import { output } from ${JSON.stringify(lexiconOutputPath)};
        import { bucket } from "./main";
        export const bucketArn = output(bucket.arn, "BucketArn");
      `,
    );

    const withoutFold = await discover(testDir);
    const withFold = await discover(testDir, { fold: true });

    expect(withFold.errors).toEqual([]);
    expect(withFold.foldDecisions.every((d) => d.mode === "fold")).toBe(true);
    expect([...withFold.entities.keys()].sort()).toEqual([...withoutFold.entities.keys()].sort());
    expect(withFold.entities.has("bucketArn")).toBe(true);

    const folded = withFold.entities.get("bucketArn")! as unknown as { outputName: string };
    const run = withoutFold.entities.get("bucketArn")! as unknown as { outputName: string };
    expect(folded.outputName).toBe("BucketArn");
    expect(folded.outputName).toBe(run.outputName);

    // An output is not a resource — the fold decision line still counts only
    // what this file contributed to Resources.
    const outputsDecision = withFold.foldDecisions.find((d) => d.file.endsWith("outputs.ts"));
    expect(outputsDecision?.resourceCount).toBe(0);
  });

  // The sibling primitive, checked in the same shape so a future change can't
  // fix one and regress the other. `stackOutput()` returns a real Declarable,
  // so it was never dropped — this pins that.
  test("a folded file's stackOutput(...) export reaches the entities map too", async () => {
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
    await writeFile(
      join(testDir, "main.ts"),
      `
        import { Bucket } from "./resources";
        export const bucket = new Bucket({ name: "my-bucket" });
      `,
    );
    await writeFile(
      join(testDir, "outputs.ts"),
      `
        import { stackOutput } from ${JSON.stringify(stackOutputPath)};
        import { bucket } from "./main";
        export const bucketArn = stackOutput(bucket.arn);
      `,
    );

    const withoutFold = await discover(testDir);
    const withFold = await discover(testDir, { fold: true });

    expect(withFold.errors).toEqual([]);
    expect(withFold.foldDecisions.every((d) => d.mode === "fold")).toBe(true);
    expect([...withFold.entities.keys()].sort()).toEqual([...withoutFold.entities.keys()].sort());
    expect(withFold.entities.has("bucketArn")).toBe(true);
    expect((withFold.entities.get("bucketArn")! as unknown as { kind: string }).kind).toBe("output");
  });

  // chant #1112 — the other half. An authoring helper reads THROUGH its ref
  // (`output()` derefs the WeakRef parent), so handing it fold's symbolic
  // `{__attrRef}` envelope for a SAME-FILE resource would build a
  // `LexiconOutput` wrapping an inert object — output that is wrong rather
  // than absent, which is worse. `reviveHelperCall` already refused this for a
  // helper nested in a value; a top-level `export const x = output(...)` goes
  // through the composite-factory spine instead and did not. Both now apply
  // the same rule, and the file falls back to run.
  test("a same-file resource reference passed to output(...) falls back to run rather than folding a wrong output", async () => {
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
    await writeFile(
      join(testDir, "stack.ts"),
      `
        import { Bucket } from "./resources";
        import { output } from ${JSON.stringify(lexiconOutputPath)};
        export const bucket = new Bucket({ name: "my-bucket" });
        export const bucketArn = output(bucket.arn, "BucketArn");
      `,
    );

    const withoutFold = await discover(testDir);
    const withFold = await discover(testDir, { fold: true });

    const decision = withFold.foldDecisions.find((d) => d.file.endsWith("stack.ts"));
    expect(decision?.mode).toBe("run");
    expect(decision?.reason).toContain("same-file resource reference");

    // Falling back is not a loss of output — the run path produces exactly
    // what it always did.
    expect(withFold.errors).toEqual([]);
    expect([...withFold.entities.keys()].sort()).toEqual([...withoutFold.entities.keys()].sort());
    expect(withFold.entities.has("bucketArn")).toBe(true);
  });

  test("a composite factory defined locally (not resolvable via import) still falls back to run; output is unchanged", async () => {
    await writeFile(
      join(testDir, "stack.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        import { Composite } from ${JSON.stringify(compositePath)};
        const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
        const LocalStack = Composite<{ name: string }>((props) => {
          const bucket = new Bucket({ name: props.name });
          return { bucket };
        }, "LocalStack");
        export const stack = LocalStack({ name: "composite-bucket" });
      `,
    );

    const withoutFold = await discover(testDir);
    const withFold = await discover(testDir, { fold: true });

    expect(withFold.errors).toEqual([]);
    expect(withFold.entities.size).toBe(withoutFold.entities.size);
    expect([...withFold.entities.keys()].sort()).toEqual([...withoutFold.entities.keys()].sort());
    expect(withFold.entities.has("stackBucket")).toBe(true);
    const folded = withFold.entities.get("stackBucket")! as unknown as { props: { name: string } };
    const run = withoutFold.entities.get("stackBucket")! as unknown as { props: { name: string } };
    expect(folded.props).toEqual(run.props);

    const stackDecision = withFold.foldDecisions.find((d) => d.file.endsWith("stack.ts"));
    expect(stackDecision?.mode).toBe("run");
    expect(stackDecision?.reason).toContain("LocalStack");
  });

  // chant #1020 — the full `discover()` pipeline, not just `tryFoldFile` in
  // isolation: two files, one importing a resource attribute from the
  // other, both fold, and `resolveAttrRefs` (the same identity-matching pass
  // the run path always used) must assign the cross-file AttrRef the
  // correct logical name with ZERO special-casing — proof the shared
  // `FoldSession` this module wires into every top-level `tryFoldFile` call
  // really does give `alb.ts` and `network.ts` the same `vpc` object.
  test("cross-file resource reference resolves end-to-end: both files fold and the AttrRef gets the right logical name", async () => {
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Vpc = createResource("Test::Vpc", "aws", { vpcId: "VpcId" });
        export const Alb = createResource("Test::Alb", "aws", { albArn: "AlbArn" });
      `,
    );
    await writeFile(
      join(testDir, "network.ts"),
      `
        import { Vpc } from "./resources";
        export const vpc = new Vpc({ cidr: "10.0.0.0/16" });
      `,
    );
    await writeFile(
      join(testDir, "alb.ts"),
      `
        import { Alb } from "./resources";
        import { vpc } from "./network";
        export const alb = new Alb({ vpcId: vpc.vpcId });
      `,
    );

    const result = await discover(testDir, { fold: true });

    expect(result.errors).toEqual([]);
    expect(result.foldDecisions.every((d) => d.mode === "fold")).toBe(true);
    expect(result.entities.has("vpc")).toBe(true);
    expect(result.entities.has("alb")).toBe(true);

    const alb = result.entities.get("alb")! as unknown as { props: { vpcId: { getLogicalName(): string | undefined; attribute: string } } };
    expect(alb.props.vpcId.getLogicalName()).toBe("vpc");
    expect(alb.props.vpcId.attribute).toBe("VpcId");
  });
});
