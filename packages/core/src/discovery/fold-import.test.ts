import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { tryFoldFile } from "./fold-import";
import { isDeclarable } from "../declarable";
import { isCompositeInstance } from "../composite";
import type { IntrinsicDef } from "../lexicon";

const thisDir = dirname(fileURLToPath(import.meta.url));
/** Absolute path to `packages/core/src/runtime.ts` — the real `createResource`
 * factory, imported by fixture files below exactly as a lexicon package
 * would be imported by real chant source. */
const runtimePath = resolve(thisDir, "../runtime");
/** Absolute path to `packages/core/src/composite.ts` — the real `Composite`
 * factory, used to build a genuine composite fixture. */
const compositePath = resolve(thisDir, "../composite");
/** Absolute path to `packages/core/src/intrinsic.ts` — the real `Intrinsic`
 * marker/interface every lexicon's own intrinsic classes (AWS's `Sub`,
 * gitlab's `reference`, …) implement. Used below to build a tagged-template
 * intrinsic fixture that is structurally identical to a real lexicon's,
 * not a simplified stand-in. */
const intrinsicPath = resolve(thisDir, "../intrinsic");

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
    if (!isDeclarable(entity)) throw new Error("expected a Declarable");
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

  // chant #1023 (epic #1019 Phase 5): a bare composite factory call, resolved
  // through the file's own imports, now folds — the factory is invoked for
  // real with statically-folded props, exactly as `#1022`'s resource
  // constructors already were. This used to be the canonical fallback case;
  // flipping it to fold is the point of #1023.
  test("folds a top-level composite factory call, zero module execution", async () => {
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
        }, "MyStack");
      `,
    );
    const file = join(testDir, "stack.ts");
    await writeFile(
      file,
      `
        import { MyStack } from "./composites";
        throw new Error("must never execute — sentinel for #1023 fold verification");
        export const stack = MyStack({ name: "composite-bucket" });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entities).toHaveLength(1);
    const [name, entity] = result.entities[0];
    expect(name).toBe("stack");
    expect(isCompositeInstance(entity)).toBe(true);
    const bucket = (entity as unknown as { bucket: unknown }).bucket;
    if (!isDeclarable(bucket)) throw new Error("expected the composite's `bucket` member to be a Declarable");
    expect(bucket.entityType).toBe("Test::Bucket");
    expect((bucket as unknown as { props: unknown }).props).toEqual({ name: "composite-bucket" });
  });

  test("falls back when the composite factory is defined locally (not resolvable via import)", async () => {
    await writeResourceDefs();
    const file = join(testDir, "stack.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        import { Composite } from ${JSON.stringify(compositePath)};
        const LocalStack = Composite<{ name: string }>((props) => {
          const bucket = new Bucket({ name: props.name });
          return { bucket };
        }, "LocalStack");
        export const stack = LocalStack({ name: "composite-bucket" });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("LocalStack");
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

  // #1025 differential regression: the constructor's optional second
  // argument (CFN-style resource attributes — DependsOn, Condition,
  // DeletionPolicy, …) was folded by fold.ts's `foldResource` but then
  // dropped on the floor here — only `entry.spec.props` was ever passed to
  // `new ResourceCtor(...)`. Confirms the fix actually reaches the
  // constructed `Declarable`, not just the intermediate `FoldedResource`
  // spec (see fold.test.ts for that narrower unit).
  test("passes the folded second argument through as the constructed entity's attributes", async () => {
    await writeResourceDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        export const bucket = new Bucket(
          { name: "my-bucket" },
          { DeletionPolicy: "Retain", DependsOn: "otherResource" },
        );
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [, entity] = result.entities[0];
    expect((entity as unknown as { attributes: unknown }).attributes).toEqual({
      DeletionPolicy: "Retain",
      DependsOn: "otherResource",
    });
  });
});

// chant #1039 — the CLI fold path hardcoded `intrinsics` to `[]` at both
// `fold-import.ts` call sites, so a registered lexicon intrinsic tagged
// template (e.g. AWS `Sub`\`...\`) never folded in production even though
// `tryFoldFile` accepted an `intrinsics` parameter. These tests exercise
// that parameter end-to-end with a REAL tagged-template intrinsic — built on
// the same `Intrinsic`/`INTRINSIC_MARKER` contract every lexicon's own
// intrinsic classes implement (see `intrinsicPath` above), not a fabricated
// shape — rather than the hand-rolled `IntrinsicDef` used by `fold.test.ts`'s
// narrower unit tests of the reducer alone.
describe("tryFoldFile — registered intrinsic tagged templates (#1039)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-fold-import-intrinsic-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const SUB: IntrinsicDef = { name: "Sub", isTag: true, outputKey: "Test::Sub" };

  /** A tagged-template intrinsic + pseudo-parameter namespace, shaped exactly like a real lexicon's (AWS's `Sub`/`AWS.StackName`): a class implementing `Intrinsic`, and a factory function invoked as `Sub`\`...\``. */
  async function writeIntrinsicDefs(): Promise<void> {
    await writeFile(
      join(testDir, "intrinsics.ts"),
      `
        import { INTRINSIC_MARKER } from ${JSON.stringify(intrinsicPath)};

        export class SubIntrinsic {
          constructor(strings, values) {
            this[INTRINSIC_MARKER] = true;
            this.strings = strings;
            this.values = values;
          }
          toJSON() {
            let out = "";
            for (let i = 0; i < this.strings.length; i++) {
              out += this.strings[i];
              if (i < this.values.length) out += String(this.values[i]);
            }
            return { "Test::Sub": out };
          }
        }

        export function Sub(strings, ...values) {
          return new SubIntrinsic(strings, values);
        }

        export const NS = { Region: "NS::Region" };
      `,
    );
  }

  async function writeResourceDefs(): Promise<void> {
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
  }

  test("a registered tag folds end-to-end to the real intrinsic's value — zero module execution", async () => {
    await writeIntrinsicDefs();
    await writeResourceDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        import { Sub, NS } from "./intrinsics";
        throw new Error("must never execute — sentinel for #1039 fold verification");
        export const bucket = new Bucket({ name: Sub\`\${NS.Region}-data\` });
      `,
    );

    const result = await tryFoldFile(file, [SUB]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entities).toHaveLength(1);
    const [name, entity] = result.entities[0];
    expect(name).toBe("bucket");
    if (!isDeclarable(entity)) throw new Error("expected a Declarable");
    // The revived value must be a genuine, live `SubIntrinsic` instance —
    // constructed by actually invoking the real `Sub` tag function through
    // this file's own imports, with "NS::Region" resolved via its `NS`
    // import — not the raw `{ __intrinsic, strings, values }` / `{ __symbol
    // }` envelope fold() produces internally (that envelope is meant to be
    // replayed, not serialized — see fold-import.ts's "Intrinsic revival"
    // section). A serializer calls `.toJSON()` on it exactly like it would
    // for any other lexicon intrinsic (e.g. AWS's real `Sub`).
    const bucketName = (entity as unknown as { props: { name: unknown } }).props.name;
    expect(bucketName).toBeInstanceOf(Object);
    expect((bucketName as { toJSON(): unknown }).toJSON()).toEqual({ "Test::Sub": "NS::Region-data" });
  });

  test("an unregistered tag still falls back to run when no intrinsics are passed", async () => {
    await writeIntrinsicDefs();
    await writeResourceDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        import { Sub, NS } from "./intrinsics";
        export const bucket = new Bucket({ name: Sub\`\${NS.Region}-data\` });
      `,
    );

    // No second argument — reproduces the exact pre-#1039 production bug
    // (the CLI fold path hardcoded this to `[]`).
    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unregistered tagged template intrinsic: Sub");
  });

  test("a same-file resource reference inside a folded intrinsic's interpolation falls back to run rather than folding to the wrong value", async () => {
    await writeIntrinsicDefs();
    await writeResourceDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        import { Sub } from "./intrinsics";
        export const a = new Bucket({ name: "a" });
        export const b = new Bucket({ name: Sub\`\${a.arn}-clone\` });
      `,
    );

    const result = await tryFoldFile(file, [SUB]);

    // Reviving would need a genuine live `AttrRef` wired to the sibling
    // entity (a WeakRef into an object this file's fold hasn't necessarily
    // constructed yet) — out of scope for #1039, same call as the existing
    // "nested `new Type(...)` as a value" rejection. Falling back to run is
    // always safe; silently folding to the raw envelope would not be.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not foldable");
  });
});
