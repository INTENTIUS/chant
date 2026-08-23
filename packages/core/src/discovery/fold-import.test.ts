import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { tryFoldFile, createFoldSession, planFoldTaint } from "./fold-import";
import { isDeclarable } from "../declarable";
import { isCompositeInstance } from "../composite";
import { isAttrRefLike } from "../utils";
import { isIntrinsic } from "../intrinsic";
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
    // chant #1054 — locks in the ONE wording for "a call used as a value,
    // not foldable" (../fold/subset.ts's `callExpressionMessage`), which
    // `resolveCallExpression` now reuses instead of its own hand-written
    // "call expression as a value" copy.
    expect(result.reason).toBe('"stack" is not foldable: function call as a value is not foldable: LocalStack(...)');
  });

  test("falls back when a top-level export's callee isn't a plain identifier (chant #1054: same wording as any other call-as-a-value rejection)", async () => {
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        const builder = { build: (props: { name: string }) => ({ name: props.name }) };
        export const stack = builder.build({ name: "x" });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('"stack" is not foldable: function call as a value is not foldable: builder.build(...)');
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

  // chant #1054 — a destructured composite export's fallback reason used to
  // embed `decl.node.getText()`: the ENTIRE call expression, which for a
  // real multi-prop composite call is many lines, burying the real error
  // after all of it. These lock in the fix: the reason names the binding(s)
  // and the callee briefly instead, and stays on one line.
  test("a destructured composite export whose source fails to resolve reports a brief, single-line reason naming the binding names and the callee", async () => {
    await writeFile(
      join(testDir, "composites.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        import { Composite } from ${JSON.stringify(compositePath)};
        const Cluster = createResource("Test::Cluster", "gcp", {});
        const NodePool = createResource("Test::NodePool", "gcp", {});
        export const GkeCluster = Composite<{ name: string; location: string }>((props) => {
          const cluster = new Cluster({ name: props.name });
          const nodePool = new NodePool({ location: props.location });
          return { cluster, nodePool };
        }, "GkeCluster");
      `,
    );
    const file = join(testDir, "cluster.ts");
    await writeFile(
      file,
      `
        import { GkeCluster } from "./composites";
        export const { cluster, nodePool } = GkeCluster({
          name: config.clusterName,
          location: config.region,
        });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain("\n");
    expect(result.reason).toContain('"cluster, nodePool" (destructured from GkeCluster(...))');
    expect(result.reason).toContain("unresolved identifier: config");
    // The whole multi-line source is gone — the reason never reproduces the
    // call's own argument list verbatim.
    expect(result.reason).not.toContain("clusterName");
  });

  test("a destructured export whose source resolves but isn't an object still reports a brief, single-line reason", async () => {
    await writeFile(
      join(testDir, "factory.ts"),
      `
        export function StringFactory(props: { text: string }): string {
          return props.text;
        }
      `,
    );
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { StringFactory } from "./factory";
        export const { length } = StringFactory({ text: "hello" });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      '"length" (destructured from StringFactory(...)) is not foldable: not a composite call or object',
    );
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

  test("an unset optional parameter folds to undefined, not null — defaults and truthiness behave (#1371)", async () => {
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { params } from ${JSON.stringify(paramsPath)};
        export const region = "us-east-1";
        export const raw = params.baseImageArn;
        export const withDefault =
          (params.baseImageArn as string | undefined) ?? \`arn:aws:lambda:\${region}:aws:microvm-image:al2023-1\`;
        export const conditional = { ...(params.baseImageArn ? { baseImageArn: params.baseImageArn } : {}) };
        export const direct = { baseImageArn: params.baseImageArn };
      `,
    );

    // Declared `required: false` with no value: the resolved map has no key at all.
    const session = createFoldSession([], {});
    const result = await tryFoldFile(file, [], session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exportedValues.get("raw")).toBeUndefined();
    expect(result.exportedValues.get("raw")).not.toBeNull();
    expect(result.exportedValues.get("withDefault")).toBe("arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1");
    expect(result.exportedValues.get("conditional")).toEqual({});
    // The key is present but undefined — what the serializers drop (see yaml.ts).
    const direct = result.exportedValues.get("direct") as { baseImageArn?: unknown };
    expect(direct.baseImageArn).toBeUndefined();
    expect(JSON.stringify(direct)).toBe("{}");
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

  test("a `params`-named import from an unrelated BARE specifier is left alone (text-match only, never resolved)", async () => {
    // Regression guard: buildExternals must recognize the build-time-params
    // bare specifier by an exact TEXT match, never by resolving an arbitrary
    // bare specifier just because the imported binding happens to be named
    // "params" — resolving every such specifier would reintroduce the exact
    // cold bare-specifier-resolution cost chant#1020 already fixed (up to
    // ~361s for a genuinely new package's first resolution in a process).
    // "left-pad" is never installed in this repo, so if this DID try to
    // resolve it, it would throw (caught) rather than hang — this test
    // mainly documents the invariant; the perf regression itself was only
    // observable via a real corpus/CI run, not a unit test.
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { params } from "left-pad";
        export const tier = params.tier;
      `,
    );

    const session = createFoldSession([], { tier: "production" });
    const result = await tryFoldFile(file, [], session);

    // Not substituted from build-time parameters (would be "production" if
    // it were) — falls back to run via the ordinary unresolved-bare-specifier
    // path, exactly as any other unimportable bare specifier would.
    expect(result.ok).toBe(false);
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

/**
 * chant #1082 — registered authoring helpers, and constructor argument
 * positions.
 *
 * Fixtures import chant-core's REAL helpers by absolute path (the convention
 * every other suite in this file uses), which is also the second arm of the
 * provenance check: a specifier that resolves inside chant-core's own tree
 * counts as chant's own, exactly like the `@intentius/chant*` package
 * specifier a real project writes.
 */
describe("tryFoldFile — registered authoring helpers (#1082)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-fold-import-helpers-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** Absolute path to the real component-authoring helpers (`phase`, `gate`, `stackOutput`). */
  const componentPath = resolve(thisDir, "../components/component");
  /** Absolute path to the real `output()` / `LexiconOutput`. */
  const lexiconOutputPath = resolve(thisDir, "../lexicon-output");

  test("a component authored with phase()/gate()/stackOutput() folds to the real plain data — zero module execution", async () => {
    const file = join(testDir, "web.component.ts");
    await writeFile(
      file,
      `
        import { phase, gate, stackOutput } from ${JSON.stringify(componentPath)};
        throw new Error("must never execute — sentinel for #1082 fold verification");
        export const web = {
          name: "web",
          dependsOn: ["shared-foundation"],
          deploy: [
            phase("Apply", [
              { kind: "cfn-deploy", stack: "web", inputs: { pVpcId: stackOutput("shared-foundation", "oVpcId") } },
              gate("approve", { timeout: "24h" }),
            ], { parallel: true }),
          ],
        };
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The revived value is what the real helpers return, not an envelope:
    // `phase()`'s `{ phase, steps, parallel }`, `gate()`'s `{ kind: "gate", … }`,
    // `stackOutput()`'s `{ stackOutput: { stack, name } }`.
    expect(result.exportedValues.get("web")).toEqual({
      name: "web",
      dependsOn: ["shared-foundation"],
      deploy: [
        {
          phase: "Apply",
          parallel: true,
          steps: [
            {
              kind: "cfn-deploy",
              stack: "web",
              inputs: { pVpcId: { stackOutput: { stack: "shared-foundation", name: "oVpcId" } } },
            },
            { kind: "gate", signalName: "approve", timeout: "24h" },
          ],
        },
      ],
    });
  });

  test("a nested (fan-out) phase folds — helper envelopes revive bottom-up", async () => {
    const file = join(testDir, "fanout.component.ts");
    await writeFile(
      file,
      `
        import { phase } from ${JSON.stringify(componentPath)};
        export const fanout = { deploy: [phase("Outer", [phase("Inner", [{ kind: "noop" }])])] };
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exportedValues.get("fanout")).toEqual({
      deploy: [{ phase: "Outer", steps: [{ phase: "Inner", steps: [{ kind: "noop" }] }] }],
    });
  });

  test("a registered NAME imported from the project's own code does NOT fold — the allowlist is chant's, not the name's", async () => {
    await writeFile(
      join(testDir, "helpers.ts"),
      `export function phase(name, steps) { return { phase: name, steps, mine: true }; }`,
    );
    const file = join(testDir, "web.component.ts");
    await writeFile(
      file,
      `
        import { phase } from "./helpers";
        export const web = { deploy: [phase("Apply", [])] };
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("./helpers");
    expect(result.reason).toContain("not chant's own");
  });

  test("a registered name declared in the file itself does NOT fold — it is not an import at all", async () => {
    const file = join(testDir, "local.component.ts");
    await writeFile(
      file,
      `
        function phase(name, steps) { return { phase: name, steps }; }
        export const web = { deploy: [phase("Apply", [])] };
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("is not a resolvable import");
  });

  test("an UNREGISTERED chant import called as a value still falls back — registration is per-helper, not per-module", async () => {
    const file = join(testDir, "unregistered.component.ts");
    await writeFile(
      file,
      `
        import { inferArchetype } from ${JSON.stringify(componentPath)};
        export const web = { archetype: inferArchetype({ deploy: [] }) };
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("inferArchetype(...)");
  });

  test("output() folds against a REAL cross-file AttrRef, producing a genuine LexiconOutput", async () => {
    await writeFile(
      join(testDir, "defs.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { Bucket } from "./defs";
        export const bucket = new Bucket({ name: "my-bucket" });
      `,
    );
    const file = join(testDir, "outputs.ts");
    await writeFile(
      file,
      `
        import { output } from ${JSON.stringify(lexiconOutputPath)};
        import { bucket } from "./resources";
        export const oArn = bucket ? output(bucket.arn, "oArn") : undefined;
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const oArn = result.exportedValues.get("oArn") as { outputName: string; sourceLexicon: string };
    // A genuine LexiconOutput built from the real AttrRef — it read the ref's
    // parent through its WeakRef to learn the lexicon, which is only possible
    // with a live reference, never with a `{ __attrRef }` envelope.
    expect(oArn.outputName).toBe("oArn");
    expect(oArn.sourceLexicon).toBe("aws");
  });

  test("output() over a SAME-FILE resource reference falls back rather than wrapping a symbolic envelope", async () => {
    await writeFile(
      join(testDir, "defs.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
    const file = join(testDir, "same-file-outputs.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./defs";
        import { output } from ${JSON.stringify(lexiconOutputPath)};
        const enabled = true;
        export const bucket = new Bucket({ name: "my-bucket" });
        export const oArn = enabled ? output(bucket.arn, "oArn") : undefined;
      `,
    );

    const result = await tryFoldFile(file);

    // `bucket.arn` folds to a `{ __attrRef }` envelope, and `LexiconOutput`'s
    // constructor needs a real `AttrRef` (it derefs the parent to learn the
    // lexicon). Constructing it from the envelope would silently produce a
    // wrong output, so the whole file falls back to run instead.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("same-file resource reference");
  });
});

describe("tryFoldFile — constructor argument positions (#1082)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-fold-import-ctorargs-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** A `(type, props)` constructor, structurally identical to the real AWS deploy-time `Parameter` (lexicons/aws/src/parameter.ts). */
  async function writeParameterDef(): Promise<void> {
    await writeFile(
      join(testDir, "parameter.ts"),
      `
        import { DECLARABLE_MARKER } from ${JSON.stringify(resolve(thisDir, "../declarable"))};

        export class Parameter {
          constructor(type, options) {
            this[DECLARABLE_MARKER] = true;
            this.lexicon = "aws";
            this.entityType = "AWS::CloudFormation::Parameter";
            this.parameterType = type;
            this.description = options?.description;
            this.defaultValue = options?.defaultValue;
          }
        }
      `,
    );
  }

  test("`new Parameter(\"String\", {...})` folds — the props object need not be the first argument", async () => {
    await writeParameterDef();
    const file = join(testDir, "params.ts");
    await writeFile(
      file,
      `
        import { Parameter } from "./parameter";
        throw new Error("must never execute — sentinel for #1082 fold verification");
        export const pVpcId = new Parameter("AWS::EC2::VPC::Id", { description: "vpc id" });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entities).toHaveLength(1);
    const [name, entity] = result.entities[0];
    expect(name).toBe("pVpcId");
    if (!isDeclarable(entity)) throw new Error("expected a Declarable");
    // Both arguments reached the real constructor, in the right positions.
    expect((entity as unknown as { parameterType: string }).parameterType).toBe("AWS::EC2::VPC::Id");
    expect((entity as unknown as { description: string }).description).toBe("vpc id");
  });

  test("a constructor called with only a non-object argument folds too — no props object is invented", async () => {
    await writeParameterDef();
    const file = join(testDir, "params.ts");
    await writeFile(
      file,
      `
        import { Parameter } from "./parameter";
        export const pName = new Parameter("String");
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [, entity] = result.entities[0];
    expect((entity as unknown as { parameterType: string }).parameterType).toBe("String");
    expect((entity as unknown as { description?: string }).description).toBeUndefined();
  });

  test("a non-foldable argument in any position still falls the file back to run", async () => {
    await writeParameterDef();
    const file = join(testDir, "params.ts");
    await writeFile(
      file,
      `
        import { Parameter } from "./parameter";
        export const pName = new Parameter(computeType(), { description: "x" });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("computeType(...)");
  });
});

/**
 * chant #1044 — registered lexicon intrinsics in PLAIN-CALL form, end to end.
 *
 * The unit tests in ../fold/fold.test.ts cover the reducer's half (a call
 * reduces to a `{__intrinsic, args}` envelope, executing nothing). These
 * cover the other half: the envelope is revived by resolving the name
 * through THIS FILE'S OWN imports and invoking the real function, so what
 * lands in a resource's props is a genuine live intrinsic instance — the
 * same object the run path would have built.
 */
describe("tryFoldFile — registered call-form intrinsics (#1044)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-fold-import-callintrinsic-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const REF: IntrinsicDef = { name: "Ref", isTag: false, foldsAsCall: true, outputKey: "Test::Ref" };
  const NOT_OPTED_IN: IntrinsicDef = { name: "Ref", isTag: false };

  /** A plain-call intrinsic shaped exactly like aws's real `Ref`: a factory returning a class that implements the `Intrinsic` contract and resolves its target at `toJSON()` time. */
  async function writeCallIntrinsicDefs(): Promise<void> {
    await writeFile(
      join(testDir, "intrinsics.ts"),
      `
        import { INTRINSIC_MARKER } from ${JSON.stringify(intrinsicPath)};

        export class RefIntrinsic {
          constructor(target) {
            this[INTRINSIC_MARKER] = true;
            this.target = target;
          }
          toJSON() {
            return { "Test::Ref": typeof this.target === "string" ? this.target : this.target.logicalHint };
          }
        }

        export function Ref(target) {
          return new RefIntrinsic(target);
        }

        export const NS = { Region: "NS::Region" };
      `,
    );
  }

  test("an opted-in call folds end-to-end to the real intrinsic instance — zero module execution", async () => {
    await writeCallIntrinsicDefs();
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        import { Ref } from "./intrinsics";
        throw new Error("must never execute — sentinel for #1044 fold verification");
        export const bucket = new Bucket({ name: Ref("environment") });
      `,
    );

    const result = await tryFoldFile(file, [REF]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [, entity] = result.entities[0];
    if (!isDeclarable(entity)) throw new Error("expected a Declarable");
    const name = (entity as unknown as { props: { name: unknown } }).props.name;
    // A genuine live instance built by the file's own `Ref`, not the
    // `{ __intrinsic, args }` envelope the reducer produced internally.
    expect((name as { toJSON(): unknown }).toJSON()).toEqual({ "Test::Ref": "environment" });
  });

  test("a call-form intrinsic folds inside a registered tag's interpolation, and a symbolic argument resolves through the file's own import", async () => {
    await writeFile(
      join(testDir, "intrinsics.ts"),
      `
        import { INTRINSIC_MARKER } from ${JSON.stringify(intrinsicPath)};
        export class RefIntrinsic {
          constructor(target) { this[INTRINSIC_MARKER] = true; this.target = target; }
          toJSON() { return { "Test::Ref": this.target }; }
        }
        export function Ref(target) { return new RefIntrinsic(target); }
        export class SubIntrinsic {
          constructor(strings, values) { this[INTRINSIC_MARKER] = true; this.strings = strings; this.values = values; }
          toJSON() {
            let out = "";
            for (let i = 0; i < this.strings.length; i++) {
              out += this.strings[i];
              if (i < this.values.length) out += JSON.stringify(this.values[i].toJSON ? this.values[i].toJSON() : this.values[i]);
            }
            return { "Test::Sub": out };
          }
        }
        export function Sub(strings, ...values) { return new SubIntrinsic(strings, values); }
        export const NS = { Region: "NS::Region" };
      `,
    );
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        import { Sub, Ref, NS } from "./intrinsics";
        export const bucket = new Bucket({ name: Sub\`\${Ref(NS.Region)}-fn\` });
      `,
    );

    const result = await tryFoldFile(file, [REF, { name: "Sub", isTag: true }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [, entity] = result.entities[0];
    if (!isDeclarable(entity)) throw new Error("expected a Declarable");
    const name = (entity as unknown as { props: { name: unknown } }).props.name;
    expect((name as { toJSON(): unknown }).toJSON()).toEqual({
      "Test::Sub": `{"Test::Ref":"NS::Region"}-fn`,
    });
  });

  test("a cross-file resource passed to an intrinsic call arrives as the SHARED live instance, not a re-imported copy", async () => {
    await writeCallIntrinsicDefs();
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Param = createResource("Test::Param", "aws", {});
      `,
    );
    await writeFile(
      join(testDir, "params.ts"),
      `
        import { Param } from "./resources";
        export const environment = new Param({ logicalHint: "EnvParam" });
      `,
    );
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Param } from "./resources";
        import { environment } from "./params";
        import { Ref } from "./intrinsics";
        export const other = new Param({ name: Ref(environment) });
      `,
    );

    const session = createFoldSession([REF]);
    const paramsResult = await tryFoldFile(join(testDir, "params.ts"), [REF], session);
    const result = await tryFoldFile(file, [REF], session);

    expect(result.ok).toBe(true);
    if (!result.ok || !paramsResult.ok) return;
    const [, entity] = result.entities[0];
    if (!isDeclarable(entity)) throw new Error("expected a Declarable");
    const ref = (entity as unknown as { props: { name: { target: unknown } } }).props.name;
    // Identity, not equality: the SAME object params.ts's own fold produced
    // and discovery will collect. A second instance would serialize with no
    // logical name at all (see planFoldTaint's doc).
    expect(ref.target).toBe(paramsResult.exportedValues.get("environment"));
  });

  test("a REGISTERED intrinsic with no opt-in still falls the file back to run", async () => {
    await writeCallIntrinsicDefs();
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        import { Ref } from "./intrinsics";
        export const bucket = new Bucket({ name: Ref("environment") });
      `,
    );

    const result = await tryFoldFile(file, [NOT_OPTED_IN]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("function call as a value is not foldable: Ref(...)");
  });

  test("an opted-in NAME that this file never imported falls back — the registry is not permission to invoke a name", async () => {
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        export const bucket = new Bucket({ name: Ref("environment") });
      `,
    );

    const result = await tryFoldFile(file, [REF]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(`"Ref" is not a resolvable import`);
  });

  test("a same-file resource reference passed to an intrinsic call falls back rather than folding to the wrong value", async () => {
    await writeCallIntrinsicDefs();
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Bucket } from "./resources";
        import { Ref } from "./intrinsics";
        export const source = new Bucket({ name: "src" });
        export const bucket = new Bucket({ name: Ref(source.arn) });
      `,
    );

    const result = await tryFoldFile(file, [REF]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("same-file resource reference");
  });
});

/**
 * chant #1063 — cross-file references into an ACTIVE LEXICON PACKAGE's
 * exports.
 *
 * #1020 taught fold to follow an identifier into another module, but only
 * through a relative/absolute specifier — a bare package specifier was
 * skipped outright, so `Azure`, `GCP`, `S3Actions` and gitlab's `CI` all
 * failed as "unresolved identifier" even though every one of them is a plain
 * `as const` object the folder already handles. These tests install a real
 * package into the fixture tree's own `node_modules` and drive the identical
 * resolution a real `@intentius/chant-lexicon-azure` import takes: a genuine
 * bare specifier, resolved by {@link fastResolveBareSpecifier} walking up to
 * `<testDir>/node_modules`, then really imported.
 *
 * Every fixture package gets a UNIQUE name. `bareSpecifierPathCache` is
 * process-wide and keyed by specifier alone (deliberately — see its doc), so
 * two tests reusing one name would have the second silently resolve to the
 * first's already-deleted directory.
 */
describe("tryFoldFile — active lexicon package exports (#1063)", () => {
  let testDir: string;
  let seq = 0;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-fold-import-lexpkg-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /**
   * Install a package into `<testDir>/node_modules/<name>` and return its
   * bare specifier. `lexiconName` is what a build would list in
   * `chant.config.ts`'s `lexicons`; the package name follows chant's one
   * naming convention (`@intentius/chant-lexicon-<name>`), same as
   * `loadPlugin()` uses.
   */
  async function installLexiconPackage(source: string): Promise<{ lexicon: string; specifier: string }> {
    const lexicon = `fold1063x${seq++}${Date.now().toString(36)}`;
    const specifier = `@intentius/chant-lexicon-${lexicon}`;
    const dir = join(testDir, "node_modules", specifier);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: specifier, version: "0.0.0", type: "module", exports: { ".": "./index.js" } }),
    );
    await writeFile(join(dir, "index.js"), source);
    return { lexicon, specifier };
  }

  /** A pseudo-parameter namespace shaped exactly like `lexicons/azure/src/pseudo.ts`'s `Azure`, plus a plain-data constants object and a callable export. */
  const LEXICON_SOURCE = `
    const INTRINSIC_MARKER = Symbol.for("chant.intrinsic");
    class ArmPseudoParameter {
      constructor(expression) {
        this[INTRINSIC_MARKER] = true;
        this.expression = expression;
      }
      toJSON() { return this.expression; }
    }
    export const ResourceGroupLocation = new ArmPseudoParameter("[resourceGroup().location]");
    export const Azure = { ResourceGroupLocation };
    export const CI = { CommitBranch: "$CI_COMMIT_BRANCH", DefaultBranch: "$CI_DEFAULT_BRANCH" };
    export const S3Actions = { ReadOnly: ["s3:GetObject", "s3:ListBucket"] };
    export function defaultTags(tags) { return tags; }
  `;

  test("a lexicon package's plain-data export resolves and folds when referenced as a value", async () => {
    const { lexicon, specifier } = await installLexiconPackage(LEXICON_SOURCE);
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { CI, S3Actions } from ${JSON.stringify(specifier)};
        throw new Error("must never execute — sentinel for #1063 fold verification");
        export const branch = CI.CommitBranch;
        export const rule = \`\${CI.CommitBranch} == \${CI.DefaultBranch}\`;
        export const actions = S3Actions.ReadOnly;
      `,
    );

    const result = await tryFoldFile(file, [], createFoldSession([], undefined, [lexicon]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exportedValues.get("branch")).toBe("$CI_COMMIT_BRANCH");
    // A template literal is the real test that the VALUE arrived, not a
    // symbolic envelope: an envelope would stringify to "[object Object]".
    expect(result.exportedValues.get("rule")).toBe("$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH");
    expect(result.exportedValues.get("actions")).toEqual(["s3:GetObject", "s3:ListBucket"]);
  });

  test("a pseudo-parameter reached through the namespace stays the REAL live Intrinsic instance, prototype intact", async () => {
    const { lexicon, specifier } = await installLexiconPackage(LEXICON_SOURCE);
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Group = createResource("Test::Group", "azure", {});
      `,
    );
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Azure } from ${JSON.stringify(specifier)};
        import { Group } from "./resources";
        export const group = new Group({ location: Azure.ResourceGroupLocation });
      `,
    );

    const result = await tryFoldFile(file, [], createFoldSession([], undefined, [lexicon]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [, entity] = result.entities[0];
    const location = (entity as unknown as { props: { location: unknown } }).props.location;
    // Not a plain-object copy: the generic revive walk would have rebuilt it
    // as `{ expression: … }` and dropped `toJSON`, which is what actually
    // reaches the serializer.
    expect(isIntrinsic(location)).toBe(true);
    expect((location as { toJSON(): unknown }).toJSON()).toBe("[resourceGroup().location]");
    // Identity: the very object the module exports, not a reconstruction —
    // the same one a run-path import of this package would hand the file.
    const mod = (await import(join(testDir, "node_modules", specifier, "index.js"))) as {
      Azure: { ResourceGroupLocation: unknown };
    };
    expect(location).toBe(mod.Azure.ResourceGroupLocation);
  });

  test("a lexicon package NOT active for this build is not resolved", async () => {
    const { specifier } = await installLexiconPackage(LEXICON_SOURCE);
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { CI } from ${JSON.stringify(specifier)};
        export const branch = CI.CommitBranch;
      `,
    );

    // The package is installed and importable — the ONLY thing missing is
    // this build having loaded it as a lexicon.
    const result = await tryFoldFile(file, [], createFoldSession([], undefined, ["aws"]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unresolved identifier: CI");
  });

  test("with no active lexicons at all, a bare specifier is skipped exactly as before", async () => {
    const { specifier } = await installLexiconPackage(LEXICON_SOURCE);
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { CI } from ${JSON.stringify(specifier)};
        export const branch = CI.CommitBranch;
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unresolved identifier: CI");
  });

  test("a non-lexicon package is never followed, even when it is installed right next to one that is", async () => {
    const { lexicon } = await installLexiconPackage(LEXICON_SOURCE);
    const vendorDir = join(testDir, "node_modules", "some-vendor-pkg");
    await mkdir(vendorDir, { recursive: true });
    await writeFile(
      join(vendorDir, "package.json"),
      JSON.stringify({ name: "some-vendor-pkg", version: "0.0.0", type: "module", exports: { ".": "./index.js" } }),
    );
    await writeFile(join(vendorDir, "index.js"), `export const SETTINGS = { region: "us-east-1" };`);

    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { SETTINGS } from "some-vendor-pkg";
        export const region = SETTINGS.region;
      `,
    );

    const result = await tryFoldFile(file, [], createFoldSession([], undefined, [lexicon]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unresolved identifier: SETTINGS");
  });

  test("a lexicon package's CALLABLE export is not bound as an identifier value", async () => {
    const { lexicon, specifier } = await installLexiconPackage(LEXICON_SOURCE);
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { defaultTags } from ${JSON.stringify(specifier)};
        export const tags = defaultTags;
      `,
    );

    const result = await tryFoldFile(file, [], createFoldSession([], undefined, [lexicon]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unresolved identifier: defaultTags");
  });

  test("process.env still rejects, with the build-parameter guidance, even with an active lexicon package in scope", async () => {
    const { lexicon, specifier } = await installLexiconPackage(LEXICON_SOURCE);
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { CI } from ${JSON.stringify(specifier)};
        export const branch = CI.CommitBranch;
        export const region = process.env.AWS_REGION;
      `,
    );

    const result = await tryFoldFile(file, [], createFoldSession([], undefined, [lexicon]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(`ambient "process" read is not foldable`);
  });
});

/**
 * chant #1169 — a `new Type(...)` used as a VALUE.
 *
 * The largest measured gate on the example corpus (64 files, the sole blocker
 * in 22 entries) and the one the original #1022-era rejection was most
 * deliberate about: `fold()` alone can only produce a `{__resource, props}`
 * envelope, and an envelope that reaches a serializer is not the value the run
 * path produced — `image: new Image({ name })` has to serialize as the
 * constructed Image's own shape, not as the envelope.
 *
 * The answer is not to normalize the envelope; it is to construct. These tests
 * are about proving that what gets constructed is INDISTINGUISHABLE from what
 * running the file would have built:
 *
 *  - a real instance of the class the file's own `import` names, with its
 *    prototype and `kind`/`entityType` intact (not a plain-object copy);
 *  - built ONCE per source construction, so a resource named by a `const` and
 *    referenced three times is one object — the same object discovery
 *    registers, which is the only reason a reference to it can resolve to a
 *    logical name at all;
 *  - behind the same #1093 gate as every other construction, so `--sandbox`
 *    still executes nothing project-owned in this process.
 */
describe("tryFoldFile — constructions as values (chant #1169)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-fold-import-1169-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** A resource class and two property-kind classes, from chant's real runtime factories — the exact shapes every lexicon's generated barrel produces. */
  async function writeDefs(): Promise<void> {
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource, createProperty } from ${JSON.stringify(runtimePath)};
        export const Job = createResource("Test::Job", "gitlab", { Id: "Id" });
        export const Image = createProperty("Test::Image", "gitlab");
        export const Rule = createProperty("Test::Rule", "gitlab");
      `,
    );
  }

  /** The `props` of a folded entity, without the `as unknown as` dance at every call site. */
  function propsOf(entity: unknown): Record<string, unknown> {
    return (entity as { props: Record<string, unknown> }).props;
  }

  test("an INLINE nested construction becomes a real instance, not a `{__resource}` envelope", async () => {
    await writeDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Job, Image } from "./resources";
        throw new Error("must never execute — sentinel for #1169 fold verification");
        export const build = new Job({ stage: "build", image: new Image({ name: "node:22-alpine" }) });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [, entity] = result.entities[0];
    const image = propsOf(entity).image;
    // The whole point: a live Declarable with its prototype, `kind` and
    // `entityType`, which is what the serializer's walker dispatches on. An
    // envelope would be a plain object with a `__resource` key and would
    // serialize as `{ __resource, props }`.
    expect(isDeclarable(image)).toBe(true);
    expect((image as unknown as { entityType: string }).entityType).toBe("Test::Image");
    expect((image as unknown as { kind: string }).kind).toBe("property");
    expect(propsOf(image)).toEqual({ name: "node:22-alpine" });
    expect(image).not.toHaveProperty("__resource");
  });

  test("constructions nest in every value position — an array element, a deeper object, a second level", async () => {
    await writeDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Job, Image, Rule } from "./resources";
        export const deploy = new Job({
          image: new Image({ name: "alpine" }),
          rules: [new Rule({ if: "$CI_COMMIT_BRANCH" }), new Rule({ when: "manual" })],
          nested: { inner: new Rule({ if: "always" }) },
        });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const props = propsOf(result.entities[0][1]);
    const rules = props.rules as unknown[];
    expect(rules).toHaveLength(2);
    expect(rules.every((r) => isDeclarable(r))).toBe(true);
    expect(propsOf(rules[0])).toEqual({ if: "$CI_COMMIT_BRANCH" });
    expect(isDeclarable((props.nested as { inner: unknown }).inner)).toBe(true);
  });

  test("the constructor's second argument (CFN-style attributes) folds a nested construction too", async () => {
    await writeDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Job, Rule } from "./resources";
        export const job = new Job({ stage: "test" }, { Metadata: new Rule({ note: "attr" }) });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const attributes = (result.entities[0][1] as unknown as { attributes: Record<string, unknown> }).attributes;
    expect(isDeclarable(attributes.Metadata)).toBe(true);
    expect(propsOf(attributes.Metadata)).toEqual({ note: "attr" });
  });

  test("a NAMED same-file resource is built ONCE — every reference is the same object", async () => {
    await writeDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Job, Image } from "./resources";
        const nodeImage = new Image({ name: "node:22-alpine" });
        export const build = new Job({ stage: "build", image: nodeImage });
        export const check = new Job({ stage: "test", image: nodeImage });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const buildImage = propsOf(result.exportedValues.get("build")).image;
    const checkImage = propsOf(result.exportedValues.get("check")).image;
    expect(isDeclarable(buildImage)).toBe(true);
    // Identity, not equality. Running the module evaluates `const nodeImage`
    // once and both jobs close over that one object; two instances here would
    // be a different program.
    expect(buildImage).toBe(checkImage);
  });

  test("a named resource referenced by another resource IS the entity discovery registers — no duplicate", async () => {
    await writeDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Job } from "./resources";
        export const first = new Job({ stage: "first" });
        export const second = new Job({ stage: "second", needs: [first] });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.exportedValues.get("first");
    const needs = propsOf(result.exportedValues.get("second")).needs as unknown[];
    // THE assertion this whole design turns on. `entities` is what discovery
    // assigns logical names to; if the reference held a second instance, the
    // serializer would find it absent from that table and inline its props
    // where the run path emits a reference — or throw "logical name not set".
    expect(needs[0]).toBe(first);
    expect(result.entities.map(([name]) => name)).toEqual(["first", "second"]);
  });

  test("`export { x }` of a same-file resource exports that same instance", async () => {
    await writeDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Job, Image } from "./resources";
        const shared = new Image({ name: "alpine" });
        const job = new Job({ image: shared });
        export { job };
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entities.map(([name]) => name)).toEqual(["job"]);
    expect(isDeclarable(propsOf(result.exportedValues.get("job")).image)).toBe(true);
  });

  test("an attribute reference to a same-file resource still folds to the `{__attrRef}` envelope, unchanged", async () => {
    await writeDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Job } from "./resources";
        export const first = new Job({ stage: "first" });
        export const second = new Job({ upstream: first.Id });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // #1169 deliberately leaves this path alone: a sibling ATTRIBUTE reference
    // is resolved by the serializer's own walker from the envelope's entity
    // NAME, and nothing about that had to change for a construction to fold.
    expect(propsOf(result.exportedValues.get("second")).upstream).toEqual({
      __attrRef: { entity: "first", attribute: "Id" },
    });
  });

  // chant #1535 — the referenced resource is declared through a conditional
  // (`flag ? new T(...) : undefined`), the kubemicrovm-ops shape that shipped
  // a role whose trust policy had `Principal: {}`. The attribute read used to
  // index the folded `{__resource}` envelope and come back `undefined`, which
  // the props walk then dropped without a diagnostic. It must now fold to the
  // same by-name envelope a bare `new` const produces, at any nesting depth.
  test("an attribute reference to a CONDITIONALLY declared same-file resource folds to the `{__attrRef}` envelope, even nested inside a document", async () => {
    await writeDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Job } from "./resources";
        const declared = true;
        export const first = declared ? new Job({ stage: "first" }) : undefined;
        const firstId = first ? first.Id : "fallback";
        export const second = new Job({
          upstream: first.Id,
          policy: { Statement: [{ Principal: { Federated: firstId } }] },
        });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entities.map(([name]) => name)).toEqual(["first", "second"]);
    const props = propsOf(result.exportedValues.get("second"));
    expect(props.upstream).toEqual({ __attrRef: { entity: "first", attribute: "Id" } });
    expect(props.policy).toEqual({
      Statement: [{ Principal: { Federated: { __attrRef: { entity: "first", attribute: "Id" } } } }],
    });
  });

  test("an attribute read on an inline resource expression falls the file back to run instead of folding to nothing", async () => {
    await writeDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Job } from "./resources";
        export const second = new Job({ upstream: (true ? new Job({}) : undefined).Id });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/attribute "Id" read on an inline resource expression is not foldable/);
  });

  test("a nested construction whose class isn't a resolvable import falls the file back to run", async () => {
    await writeDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Job } from "./resources";
        export const job = new Job({ image: new Unimported({ name: "x" }) });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(`constructor "Unimported" is not a resolvable import`);
  });

  test("a nested `new ns.Type(...)` through a namespace import stays rejected", async () => {
    await writeDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Job } from "./resources";
        import * as res from "./resources";
        export const job = new Job({ image: new res.Image({ name: "x" }) });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Shape-level: a dotted callee cannot be resolved to a live class through
    // the file's named imports, so it never folds to an envelope nothing could
    // revive. Same bare-identifier rule as an intrinsic call and #1023's
    // factory-body construction.
    expect(result.reason).toContain("needs a plain imported constructor");
  });

  test("a same-file resource used as a value rejects when no construction is available", async () => {
    // The divergence #1169 adds, in the one direction that is safe. When the
    // class can't be resolved there is no instance to point at, and re-folding
    // the initializer would build a duplicate — so the reference rejects and
    // the file falls back to run, where both references are the same object by
    // construction.
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Job } from "./missing-module";
        const shared = new Job({ stage: "a" });
        export const job = new Job({ needs: [shared] });
      `,
    );

    const result = await tryFoldFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("same-file resource `shared` used as a value is not foldable");
  });

  test("a construction whose class is a PROJECT file folds under plain --fold and REFUSES under --sandbox", async () => {
    // chant #1093 — a nested construction reaches its class through exactly the
    // same binding gate every other construction does, so it cannot widen the
    // boundary. `./resources.ts` is project source: trusted enough to import
    // under plain `--fold` (the run path imports it too), never under
    // `--sandbox`, where the file demotes to the child instead.
    await writeDefs();
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Job, Image } from "./resources";
        export const job = new Job({ image: new Image({ name: "alpine" }) });
      `,
    );

    const plain = await tryFoldFile(file, [], createFoldSession([], undefined, [], false));
    expect(plain.ok).toBe(true);

    const sandboxed = await tryFoldFile(file, [], createFoldSession([], undefined, [], true));
    expect(sandboxed.ok).toBe(false);
    if (sandboxed.ok) return;
    expect(sandboxed.reason).toContain("--sandbox");
    expect(sandboxed.reason).toContain(`constructor "Image"`);
  });

  test("a nested instance reaches another file only through an exported object, and that edge is already recorded", async () => {
    // chant #1097's question, answered for #1169. A nested instance is an
    // inline value: it is never an export of its own, so no other file can name
    // it. The one way another file CAN observe it is by importing the object
    // that holds it — and that is an ordinary cross-file object edge, already
    // recorded in `liveSources` and already reverse-taint-propagated by
    // `planFoldTaint` (#1044). Nothing new to track.
    await writeDefs();
    await writeFile(
      join(testDir, "shared.ts"),
      `
        import { Image } from "./resources";
        export const cfg = { image: new Image({ name: "alpine" }) };
      `,
    );
    const file = join(testDir, "main.ts");
    await writeFile(
      file,
      `
        import { Job } from "./resources";
        import { cfg } from "./shared";
        export const job = new Job({ image: cfg.image });
      `,
    );

    const session = createFoldSession();
    const sharedPath = join(testDir, "shared.ts");
    const sharedResult = await tryFoldFile(sharedPath, [], session);
    const result = await tryFoldFile(file, [], session);

    expect(result.ok).toBe(true);
    expect(sharedResult.ok).toBe(true);
    if (!result.ok || !sharedResult.ok) return;

    const sharedImage = (sharedResult.exportedValues.get("cfg") as { image: unknown }).image;
    // Identity across the file boundary — one instance, shared, exactly as
    // Node's module cache would give the run path.
    expect(propsOf(result.exportedValues.get("job")).image).toBe(sharedImage);
    // And the edge that makes it safe: main.ts is on record as having consumed
    // shared.ts's objects, so if shared.ts is ever forced back to run, main.ts
    // is forced with it rather than left holding a stale instance.
    expect([...result.liveSources]).toContain(sharedPath);

    const tainted = await planFoldTaint(
      [file, sharedPath],
      new Map([
        [file, false],
        [sharedPath, true],
      ]),
      new Map([[file, result.liveSources]]),
    );
    expect(tainted.has(sharedPath)).toBe(true);
  });
});
