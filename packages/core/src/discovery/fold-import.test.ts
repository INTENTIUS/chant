import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { tryFoldFile, createFoldSession } from "./fold-import";
import { isDeclarable } from "../declarable";
import { isCompositeInstance } from "../composite";
import { isAttrRefLike } from "../utils";
import { params as sharedParams } from "../params";
import type { AttrRef } from "../attrref";
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
/** Absolute path to `packages/core/src/params.ts` — chant #1064's build-time-parameters
 * runtime module. A real project imports this as the bare specifier
 * "@intentius/chant/params"; fixture files below use the absolute path instead
 * (same convention as `runtimePath` etc. above), but {@link buildExternals}'s
 * recognition is specifier-shape-agnostic — see fold-import.ts's own comment —
 * so this exercises the identical code path a real bare import would take. */
const paramsPath = resolve(thisDir, "../params");

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

  // chant #1020: a plain-value-only export now folds too (contributing
  // nothing to `entities` — only Declarable/CompositeInstance land there —
  // but recorded in `exportedValues`). This is intentional, not a relaxed
  // subset: `fold()` already reduced a bare literal trivially; the only
  // change is that `tryFoldFile` now ALSO tries it for a "single" declarator
  // instead of only the composite-call spine. It matters for #1020's own
  // acceptance criterion — a config/params file that exports nothing but
  // plain consts must be safe to fold (0 entities either way), or
  // `planFoldTaint` would needlessly force every file that imports one of
  // its constants back to run too.
  test("a plain-value-only export now folds — zero entities, but the value is recorded for cross-file reference", async () => {
    const file = join(testDir, "main.ts");
    await writeFile(file, `export const helperValue = 5;`);

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entities).toEqual([]);
    expect(result.exportedValues.get("helperValue")).toBe(5);
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

// chant #1020 (epic #1019) — cross-file resolution: an imported binding now
// folds by resolving it to its `export const` initializer and folding it in
// the DEFINING module's own scope, instead of failing the whole importing
// file on the first identifier it doesn't recognize.
describe("tryFoldFile — cross-file resolution (chant #1020)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-fold-import-crossfile-test-${Date.now()}-${Math.random()}`);
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
        export const Vpc = createResource("Test::Vpc", "aws", { vpcId: "VpcId" });
        export const Alb = createResource("Test::Alb", "aws", { albArn: "AlbArn" });
      `,
    );
  }

  test("an imported plain const folds identically to an inline one", async () => {
    await writeResourceDefs();
    await writeFile(join(testDir, "config.ts"), `export const REGION = "us-east-1";`);
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        import { REGION } from "./config";
        export const bucket = new Bucket({ name: "b", region: REGION });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [, entity] = result.entities[0];
    expect((entity as unknown as { props: unknown }).props).toEqual({ name: "b", region: "us-east-1" });
  });

  test("config.ts's own fold succeeds with zero entities — a plain-const-only file must not be tainted merely for existing", async () => {
    const file = join(testDir, "config.ts");
    await writeFile(file, `export const REGION = "us-east-1";\nexport const RETRIES = 3;`);

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entities).toEqual([]);
    expect(result.exportedValues.get("REGION")).toBe("us-east-1");
    expect(result.exportedValues.get("RETRIES")).toBe(3);
  });

  test("a cross-file resource attribute reference folds to a real AttrRef", async () => {
    await writeResourceDefs();
    await writeFile(
      join(testDir, "network.ts"),
      `
        import { Vpc } from "./resources";
        export const vpc = new Vpc({ cidr: "10.0.0.0/16" });
      `,
    );
    const file = join(testDir, "alb.ts");
    await writeFile(
      file,
      `
        import { Alb } from "./resources";
        import { vpc } from "./network";
        export const alb = new Alb({ vpcId: vpc.vpcId });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [, entity] = result.entities[0];
    const vpcId = (entity as unknown as { props: { vpcId: unknown } }).props.vpcId;
    expect(isAttrRefLike(vpcId)).toBe(true);
  });

  // The hard part (see planFoldTaint's module doc): fold and run must never
  // disagree about object identity. If `alb.ts` reached into `network.ts`
  // and built a SECOND copy of `network.vpc`, that copy would never match
  // discover()'s entities map by identity and serialization would crash, not
  // drift. Asserted with `toBe` — identity, not `toEqual`'s structural check.
  test("a cross-file reference shares the EXACT SAME entity instance as the defining file's own fold — not a duplicate", async () => {
    await writeResourceDefs();
    const networkFile = join(testDir, "network.ts");
    await writeFile(
      networkFile,
      `
        import { Vpc } from "./resources";
        export const vpc = new Vpc({ cidr: "10.0.0.0/16" });
      `,
    );
    const albFile = join(testDir, "alb.ts");
    await writeFile(
      albFile,
      `
        import { Alb } from "./resources";
        import { vpc } from "./network";
        export const alb = new Alb({ vpcId: vpc.vpcId });
      `,
    );

    // One shared session, exactly as `discover()` gives its own per-file
    // loop — this is what a real build does; two independent `tryFoldFile`
    // calls with no session would each fold `network.ts` on their own and
    // legitimately produce two different (if structurally equal) objects.
    const session = createFoldSession();
    const networkResult = await tryFoldFile(networkFile, [], session);
    const albResult = await tryFoldFile(albFile, [], session);

    expect(networkResult.ok).toBe(true);
    expect(albResult.ok).toBe(true);
    if (!networkResult.ok || !albResult.ok) return;

    const [, vpcEntity] = networkResult.entities[0];
    const [, albEntity] = albResult.entities[0];
    const vpcIdRef = (albEntity as unknown as { props: { vpcId: AttrRef } }).props.vpcId;
    expect(vpcIdRef.parent.deref()).toBe(vpcEntity);
  });

  // A diamond — TWO paths reaching the SAME module (b.ts and c.ts both
  // import hub.ts; neither imports the other) — is the case that silently
  // degrades to duplicated (or, nested a few levels deep, EXPONENTIAL) work
  // without a resolution memo, yet produces no error at all: each path just
  // independently re-resolves the shared module. Distinct from the reference
  // CYCLE tests below, which fail loudly; this one must instead prove the
  // hub was folded exactly once and every referrer shares that one object.
  // An explicit test timeout below turns a reintroduced non-terminating bug
  // into a fast, clearly-labeled failure instead of a hung test run.
  test(
    "a diamond (two independent paths reaching the same module) resolves without re-resolving the shared module",
    async () => {
      await writeResourceDefs();
      await writeFile(
        join(testDir, "hub.ts"),
        `
          import { Vpc } from "./resources";
          export const vpc = new Vpc({ cidr: "10.0.0.0/16" });
        `,
      );
      await writeFile(
        join(testDir, "b.ts"),
        `
          import { Alb } from "./resources";
          import { vpc } from "./hub";
          export const b = new Alb({ vpcId: vpc.vpcId });
        `,
      );
      await writeFile(
        join(testDir, "c.ts"),
        `
          import { Alb } from "./resources";
          import { vpc } from "./hub";
          export const c = new Alb({ vpcId: vpc.vpcId });
        `,
      );

      const session = createFoldSession();
      const hubResult = await tryFoldFile(join(testDir, "hub.ts"), [], session);
      const bResult = await tryFoldFile(join(testDir, "b.ts"), [], session);
      const cResult = await tryFoldFile(join(testDir, "c.ts"), [], session);

      expect(hubResult.ok).toBe(true);
      expect(bResult.ok).toBe(true);
      expect(cResult.ok).toBe(true);
      if (!hubResult.ok || !bResult.ok || !cResult.ok) return;

      const [, hubVpc] = hubResult.entities[0];
      const [, bEntity] = bResult.entities[0];
      const [, cEntity] = cResult.entities[0];
      const bVpcId = (bEntity as unknown as { props: { vpcId: AttrRef } }).props.vpcId;
      const cVpcId = (cEntity as unknown as { props: { vpcId: AttrRef } }).props.vpcId;
      // If the hub were re-resolved once per path (the un-memoized failure
      // mode), each path would construct its OWN, distinct `Vpc` instance —
      // these `toBe` checks would fail (not hang) in that case.
      expect(bVpcId.parent.deref()).toBe(hubVpc);
      expect(cVpcId.parent.deref()).toBe(hubVpc);
      // hub.ts/b.ts/c.ts (3) plus the two shared fixture-support files each
      // of them transitively imports — resources.ts, and (via its own
      // absolute-path import, see `runtimePath`'s doc above) runtime.ts
      // itself — each attempted/cached exactly ONCE too, not once per
      // referrer. The point of this count isn't the literal number 5; it's
      // that it's flat regardless of how many paths (b.ts AND c.ts) lead to
      // the SAME file, which is what a broken/missing memo would violate.
      expect(session.cache.size).toBe(5);
    },
    5000,
  );

  // A wider fan-out (many files, all reaching one shared hub, plus a short
  // dependency chain) than the minimal diamond above — cheap enough to stay
  // well under the explicit timeout if resolution is O(files), but would
  // measurably blow up if the hub (or the chain) were re-resolved once per
  // referrer instead of once per session.
  test(
    "a wide fan-out to one shared hub resolves promptly (no combinatorial blowup)",
    async () => {
      await writeResourceDefs();
      await writeFile(
        join(testDir, "hub.ts"),
        `
          import { Vpc } from "./resources";
          export const vpc = new Vpc({ cidr: "10.0.0.0/16" });
        `,
      );
      const FANOUT = 15;
      const files: string[] = [];
      for (let i = 0; i < FANOUT; i++) {
        const f = join(testDir, `leaf${i}.ts`);
        await writeFile(
          f,
          `
            import { Alb } from "./resources";
            import { vpc } from "./hub";
            export const leaf = new Alb({ vpcId: vpc.vpcId });
          `,
        );
        files.push(f);
      }

      const session = createFoldSession();
      const hubResult = await tryFoldFile(join(testDir, "hub.ts"), [], session);
      expect(hubResult.ok).toBe(true);
      if (!hubResult.ok) return;
      const [, hubVpc] = hubResult.entities[0];

      for (const f of files) {
        const result = await tryFoldFile(f, [], session);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        const [, entity] = result.entities[0];
        const vpcId = (entity as unknown as { props: { vpcId: AttrRef } }).props.vpcId;
        expect(vpcId.parent.deref()).toBe(hubVpc);
      }

      // hub.ts + the two shared fixture-support files (resources.ts,
      // runtime.ts — see the diamond test above) + FANOUT leaves. Flat in
      // FANOUT's shared dependencies regardless of FANOUT's size is exactly
      // the property a broken memo would violate.
      expect(session.cache.size).toBe(FANOUT + 3);
    },
    5000,
  );

  test("a namespace import's member access resolves cross-file (import * as ns)", async () => {
    await writeResourceDefs();
    await writeFile(
      join(testDir, "ecr.ts"),
      `
        import { Bucket } from "./resources";
        export const apiRepo = new Bucket({ name: "api-repo" });
        export const uiRepo = new Bucket({ name: "ui-repo" });
      `,
    );
    const file = join(testDir, "outputs.ts");
    await writeFile(
      file,
      `
        import { Alb } from "./resources";
        import * as ecr from "./ecr";
        export const alb = new Alb({ albArn: ecr.apiRepo.arn });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [, entity] = result.entities[0];
    const albArn = (entity as unknown as { props: { albArn: unknown } }).props.albArn;
    expect(isAttrRefLike(albArn)).toBe(true);
  });

  test("a re-export chain (`export { x } from \"./y\"`) resolves cross-file, sharing the same instance", async () => {
    await writeResourceDefs();
    const implFile = join(testDir, "impl.ts");
    await writeFile(
      implFile,
      `
        import { Bucket } from "./resources";
        export const bucket = new Bucket({ name: "impl-bucket" });
      `,
    );
    const barrelFile = join(testDir, "barrel.ts");
    await writeFile(barrelFile, `export { bucket } from "./impl";`);

    const session = createFoldSession();
    const implResult = await tryFoldFile(implFile, [], session);
    const barrelResult = await tryFoldFile(barrelFile, [], session);

    expect(implResult.ok).toBe(true);
    expect(barrelResult.ok).toBe(true);
    if (!implResult.ok || !barrelResult.ok) return;
    expect(barrelResult.entities).toHaveLength(1);
    const [name, barrelBucket] = barrelResult.entities[0];
    expect(name).toBe("bucket");
    const [, implBucket] = implResult.entities[0];
    expect(barrelBucket).toBe(implBucket);
  });

  test("a re-export chain resolves transitively through more than one hop", async () => {
    await writeResourceDefs();
    await writeFile(
      join(testDir, "impl.ts"),
      `
        import { Bucket } from "./resources";
        export const bucket = new Bucket({ name: "impl-bucket" });
      `,
    );
    await writeFile(join(testDir, "mid-barrel.ts"), `export { bucket } from "./impl";`);
    const topBarrel = join(testDir, "top-barrel.ts");
    await writeFile(topBarrel, `export { bucket as sharedBucket } from "./mid-barrel";`);

    const result = await tryFoldFile(topBarrel);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entities).toHaveLength(1);
    const [name, entity] = result.entities[0];
    expect(name).toBe("sharedBucket");
    if (!isDeclarable(entity)) throw new Error("expected a Declarable");
    expect((entity as unknown as { props: unknown }).props).toEqual({ name: "impl-bucket" });
  });

  // Explicit timeouts throughout this describe's cycle tests: a regression
  // that broke cycle detection (rather than just mis-formatting its message)
  // would hang, not fail — a bounded test timeout turns that into a fast,
  // clearly-labeled failure instead of a stuck test run.
  test(
    "an import cycle produces a located FoldError naming the cycle path",
    async () => {
      await writeFile(
        join(testDir, "a.ts"),
        `
        import { B_VALUE } from "./b";
        export const A_VALUE = "a-" + B_VALUE;
      `,
      );
      await writeFile(
        join(testDir, "b.ts"),
        `
        import { A_VALUE } from "./a";
        export const B_VALUE = "b-" + A_VALUE;
      `,
      );

      const result = await tryFoldFile(join(testDir, "a.ts"));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("import cycle");
      expect(result.reason).toContain("a.ts");
      expect(result.reason).toContain("b.ts");
      // Located — "line:col - message", the same `FoldError` formatting as
      // every other fold rejection, not a bare unpositioned string.
      expect(result.reason).toMatch(/\d+:\d+ - /);
    },
    5000,
  );

  test(
    "a self-cycle (a file whose own re-export chain reaches back to itself) is also detected",
    async () => {
      await writeFile(join(testDir, "a.ts"), `export { x } from "./b";`);
      const file = join(testDir, "b.ts");
      await writeFile(file, `export { x } from "./a";`);

      const result = await tryFoldFile(file);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("import cycle");
    },
    5000,
  );

  // A 3-file cycle where the loop closes several hops away from where it
  // started (a -> b -> c -> a), not just a direct pair — proves cycle
  // detection walks the whole `stack`, not just the immediate caller.
  test(
    "a longer cycle (three files) is detected, not just a direct pair",
    async () => {
      await writeFile(join(testDir, "a.ts"), `import { c } from "./c";\nexport const a = "a" + c;`);
      await writeFile(join(testDir, "b.ts"), `import { a } from "./a";\nexport const b = "b" + a;`);
      await writeFile(join(testDir, "c.ts"), `import { b } from "./b";\nexport const c = "c" + b;`);

      const result = await tryFoldFile(join(testDir, "b.ts"));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("import cycle");
    },
    5000,
  );
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

describe("tryFoldFile — build-time parameters (chant #1064)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-fold-import-buildparams-test-${Date.now()}-${Math.random()}`);
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

  test("a direct params.<name> declarator folds to a LITERAL, not a symbolic node", async () => {
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { params } from ${JSON.stringify(paramsPath)};
        export const tier = params.tier;
      `,
    );

    const session = createFoldSession([], { tier: "production" });
    const result = await tryFoldFile(file, [], session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exportedValues.get("tier")).toBe("production");
  });

  test("params.<name> nested inside a resource's props folds through the general reducer", async () => {
    await writeResourceDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        import { params } from ${JSON.stringify(paramsPath)};
        export const bucket = new Bucket({ name: params.env });
      `,
    );

    const session = createFoldSession([], { env: "staging" });
    const result = await tryFoldFile(file, [], session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entities).toHaveLength(1);
    const [, entity] = result.entities[0];
    if (!isDeclarable(entity)) throw new Error("expected a Declarable");
    expect((entity as unknown as { props: { name: unknown } }).props.name).toBe("staging");
  });

  test("a nullish-coalesced default still folds to a literal (loomster's `params.x ?? \"default\"` pattern)", async () => {
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { params } from ${JSON.stringify(paramsPath)};
        export const project = params.project ?? "loom";
      `,
    );

    // No "project" key supplied — falls through to the literal default.
    const session = createFoldSession([], {});
    const result = await tryFoldFile(file, [], session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exportedValues.get("project")).toBe("loom");
  });

  test("an unrelated import also named `params` (not resolving to ../params.ts) is unaffected", async () => {
    await writeFile(
      join(testDir, "local-config.ts"),
      `export const params = { tier: "should-not-be-used" };`,
    );
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { params } from "./local-config";
        export const tier = params.tier;
      `,
    );

    const session = createFoldSession([], { tier: "production" });
    const result = await tryFoldFile(file, [], session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Resolved via the ORDINARY cross-file project resolution, not the
    // build-time-parameters substitution — proves the two never collide.
    expect(result.exportedValues.get("tier")).toBe("should-not-be-used");
  });

  test("without a FoldSession buildParams, params.<name> is an unresolved identifier (matches an ordinary bare import)", async () => {
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { params } from ${JSON.stringify(paramsPath)};
        export const tier = params.tier;
      `,
    );

    // No session passed at all — tryFoldFile creates a private one with no buildParams.
    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
  });

  test("real end-to-end parity: the fold path substitutes without ever importing ../params.ts, while a real run-fallback import sees the same values via setBuildParams", async () => {
    // Simulates what discover() does before either fold or run touches a file.
    const { setBuildParams } = await import("../params");
    setBuildParams({ tier: "production-ha" });

    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { params } from ${JSON.stringify(paramsPath)};
        export const tier = params.tier;
      `,
    );

    const session = createFoldSession([], { tier: "production-ha" });
    const folded = await tryFoldFile(file, [], session);
    expect(folded.ok).toBe(true);
    if (folded.ok) expect(folded.exportedValues.get("tier")).toBe("production-ha");

    // A real import of the shared module (what a run-fallback file's own
    // `import()` would do) observes the identical value — same object,
    // mutated in place, not re-bound.
    expect(sharedParams.tier).toBe("production-ha");

    setBuildParams({});
  });
});
