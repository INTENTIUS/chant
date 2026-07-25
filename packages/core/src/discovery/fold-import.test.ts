import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { tryFoldFile } from "./fold-import";
import { isDeclarable } from "../declarable";

const thisDir = dirname(fileURLToPath(import.meta.url));
/** Absolute path to `packages/core/src/runtime.ts` — the real `createResource`
 * factory, imported by fixture files below exactly as a lexicon package
 * would be imported by real chant source. */
const runtimePath = resolve(thisDir, "../runtime");
/** Absolute path to `packages/core/src/composite.ts` — the real `Composite`
 * factory, used to build a genuine composite fixture. */
const compositePath = resolve(thisDir, "../composite");

describe("tryFoldFile", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-fold-import-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeResourceDefs(): Promise<void> {
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
  }

  test("folds a leaf resource to a real Declarable with zero module execution", async () => {
    await writeResourceDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        throw new Error("must never execute — sentinel for #1022 fold verification");
        export const bucket = new Bucket({ name: "my-bucket", versioned: true });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entities).toHaveLength(1);
    const [name, entity] = result.entities[0];
    expect(name).toBe("bucket");
    expect(isDeclarable(entity)).toBe(true);
    expect(entity.lexicon).toBe("aws");
    expect(entity.entityType).toBe("Test::Bucket");
    expect((entity as unknown as { props: unknown }).props).toEqual({
      name: "my-bucket",
      versioned: true,
    });
  });

  test("folds multiple leaf resources from one file", async () => {
    await writeResourceDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        export const a = new Bucket({ name: "a" });
        export const b = new Bucket({ name: "b" });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entities.map(([name]) => name).sort()).toEqual(["a", "b"]);
  });

  test("falls back when the file instantiates a composite (call, not `new`)", async () => {
    await writeResourceDefs();
    await writeFile(
      join(testDir, "composites.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        import { Composite } from ${JSON.stringify(compositePath)};
        const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
        export const MyStack = Composite<{ name: string }>((props) => {
          const bucket = new Bucket({ name: props.name });
          return { bucket };
        });
      `,
    );
    const file = join(testDir, "stack.ts");
    await writeFile(
      file,
      `
        import { MyStack } from "./composites";
        export const stack = MyStack({ name: "composite-bucket" });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not a `new Type(...)` resource declaration");
  });

  test("falls back when a prop value is not foldable", async () => {
    await writeResourceDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        function computeName(): string { return "dynamic"; }
        export const bucket = new Bucket({ name: computeName() });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("computeName");
  });

  test("falls back when the resource constructor is not a resolvable import", async () => {
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        export const bucket = new Bucket({ name: "my-bucket" });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not a resolvable import");
  });

  test("falls back on `export default`", async () => {
    await writeResourceDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        const bucket = new Bucket({ name: "my-bucket" });
        export default bucket;
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("export default");
  });

  test("falls back when there are no exports at all", async () => {
    const file = join(testDir, "main.ts");
    await writeFile(file, `const helperValue = 5;`);

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no foldable resource exports");
  });

  test("falls back when an exported const is a plain value, not a resource", async () => {
    const file = join(testDir, "main.ts");
    await writeFile(file, `export const helperValue = 5;`);

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not a `new Type(...)` resource declaration");
  });
});
