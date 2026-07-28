import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { discover } from "./index";
import { build } from "../build";
import { walkValue } from "../serializer-walker";
import type { Declarable } from "../declarable";
import type { Serializer } from "../serializer";
import { foldExecutionCounts, resetFoldExecutionCounts, findFactorySubsetViolation } from "./fold-import";

/**
 * chant #1023 (epic #1019 Phase 5) — composite factory INTERPRETATION.
 *
 * `resolveCallExpression` used to have exactly one way to get a composite's
 * value: import the defining module and call the factory, in the CLI's own
 * process. That is the execution chant #1093 documented and #1111 could only
 * fence off by DEMOTING the file to the sandboxed child. Interpretation
 * removes the call for factories whose bodies stay inside the admissible
 * subset — see fold-import.ts's contract block for the five rules.
 *
 * These tests observe the removal directly rather than inferring it, borrowing
 * ./sandbox/fold-boundary.test.ts's discipline: the composite's defining
 * module sets a `globalThis` marker at its top level, so "marker set" is
 * exactly "this module was imported and run here". The inadmissible variant is
 * asserted FIRST, so the probe is proven capable of firing before anything
 * asserts that it doesn't.
 *
 * The defining modules deliberately sit OUTSIDE the discovered source
 * directory. Inside it they would be discovered files in their own right —
 * and a module whose job is to export a factory function never folds, so
 * discovery would import it regardless and the marker would fire for a reason
 * that has nothing to do with the factory call.
 */

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "../../../..");
const compositePath = resolve(thisDir, "../composite");

/**
 * The real AWS lexicon — an ACTIVE lexicon of every build below, so its
 * constructors sit on chant #1093's trusted allowlist exactly as they do for a
 * real project, and the `--sandbox` assertions are about interpretation rather
 * than about a stand-in nobody would ship. `Bucket`/`Role` carry genuine `Arn`
 * attributes, so a sibling reference inside a factory body produces a genuine
 * `AttrRef`; `Tag` is a property-kind class, for the nested-construction case.
 */
const LEXICON = "@intentius/chant-lexicon-aws";
const LEXICON_NAME = "aws";

const MODULE_MARKER = "__chant1023CompositeModuleEvaluated";

type MarkerHost = Record<string, boolean | undefined>;

function moduleRan(): boolean | undefined {
  return (globalThis as unknown as MarkerHost)[MODULE_MARKER];
}

function clearMarker(): void {
  delete (globalThis as unknown as MarkerHost)[MODULE_MARKER];
}

/** A serializer that renders every entity's real, ref-resolved props — enough to compare a fold build against a run build byte for byte. */
const specSerializer: Serializer = {
  // Named for the lexicon whose entities it serializes — `build()` selects a
  // serializer by the entities' own `lexicon`, not by an arbitrary label.
  name: LEXICON_NAME,
  rulePrefix: "TEST",
  serialize: (entities) => {
    const names = new Map<Declarable, string>();
    for (const [name, entity] of entities) names.set(entity, name);
    const out: Record<string, unknown> = {};
    for (const [name, entity] of [...entities].sort(([a], [b]) => a.localeCompare(b))) {
      out[name] = {
        type: entity.entityType,
        props: walkValue((entity as unknown as { props: unknown }).props, names, {
          attrRef: (logicalName, attribute) => ({ GetAtt: [logicalName, attribute] }),
          resourceRef: (logicalName) => ({ Ref: logicalName }),
          propertyDeclarable: (e, walk) => walk((e as unknown as { props: unknown }).props),
        }),
      };
    }
    return JSON.stringify(out, null, 2);
  },
};

let seq = 0;

describe("composite factory interpretation (chant #1023)", () => {
  let testDir: string;
  let srcDir: string;

  beforeEach(async () => {
    // Inside the repo (`.cache/` is gitignored), not the system tmpdir, for one
    // reason: the fixtures import the REAL lexicon package above, which only
    // resolves from a directory whose `node_modules` walk reaches this
    // checkout's.
    const dir = join(repoRoot, ".cache", `chant-1023-${process.pid}-${seq++}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    testDir = await realpath(dir);
    srcDir = join(testDir, "src");
    await mkdir(srcDir, { recursive: true });
    clearMarker();
    resetFoldExecutionCounts();
  });

  afterEach(async () => {
    clearMarker();
    await rm(testDir, { recursive: true, force: true });
  });

  /** `composites.ts` — a PROJECT module defining one composite, plus the execution probe. */
  async function writeComposite(body: string, extraExports = ""): Promise<void> {
    await writeFile(
      join(testDir, "composites.ts"),
      `
        import { Bucket, Role, Tag } from ${JSON.stringify(LEXICON)};
        import { Composite } from ${JSON.stringify(compositePath)};

        globalThis[${JSON.stringify(MODULE_MARKER)}] = true;

        export const WebApp = Composite(${body}, "WebApp");
        ${extraExports}
      `,
    );
  }

  async function writeMain(source: string): Promise<void> {
    await writeFile(join(srcDir, "main.ts"), source);
  }

  const CALL_WEBAPP = `
    import { WebApp } from "../composites";
    export const web = WebApp({ name: "data", tags: [{ Key: "team", Value: "platform" }] });
  `;

  /**
   * The canonical body: `const`s that construct resources, a live sibling
   * reference, a `??` default, a spread, a nested property construction, a
   * template, and a return of the member record. Everything the contract
   * admits, in one factory.
   */
  const ADMISSIBLE_BODY = `(props) => {
    const bucket = new Bucket({
      BucketName: props.name,
      VersioningConfiguration: props.versioning ?? { Status: "Enabled" },
      Tags: [...(props.tags ?? []), { Key: "managed-by", Value: "chant" }],
    });
    const role = new Role({
      RoleName: \`role-for-\${props.name}\`,
      Description: bucket.Arn,
      Tags: [new Tag({ Key: "owner", Value: props.name })],
    });
    return { bucket, role };
  }`;

  /** A body one `if` outside the subset — otherwise identical in what it produces. */
  const INADMISSIBLE_BODY = `(props) => {
    if (!props.name) { throw new Error("name required"); }
    const bucket = new Bucket({ BucketName: props.name });
    return { bucket };
  }`;

  // ───────────────────────────────────────────────────────────────────────
  // The probe fires — an inadmissible factory still invokes, exactly as before.
  // ───────────────────────────────────────────────────────────────────────

  test("an INADMISSIBLE factory is still invoked in-process (the probe fires)", async () => {
    await writeComposite(INADMISSIBLE_BODY);
    await writeMain(CALL_WEBAPP);

    const result = await discover(srcDir, { fold: true, lexicons: [LEXICON_NAME] });

    expect(result.errors).toEqual([]);
    expect(result.foldDecisions.find((d) => d.file.endsWith("main.ts"))?.mode).toBe("fold");
    expect(moduleRan(), "the defining module must have been imported and run here").toBe(true);
    expect(foldExecutionCounts()).toMatchObject({ factoryInterpretations: 0, projectFactoryInvocations: 1 });
    expect([...result.entities.keys()]).toEqual(["webBucket"]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // The removal itself.
  // ───────────────────────────────────────────────────────────────────────

  test("an admissible factory is interpreted — its module is never imported", async () => {
    await writeComposite(ADMISSIBLE_BODY);
    await writeMain(CALL_WEBAPP);

    const result = await discover(srcDir, { fold: true, lexicons: [LEXICON_NAME] });

    expect(result.errors).toEqual([]);
    expect(result.foldDecisions.find((d) => d.file.endsWith("main.ts"))?.mode).toBe("fold");
    expect(moduleRan(), "composites.ts must NOT have been imported").toBeUndefined();
    expect(foldExecutionCounts()).toMatchObject({ factoryInterpretations: 1, projectFactoryInvocations: 0 });
    expect([...result.entities.keys()].sort()).toEqual(["webBucket", "webRole"]);
  });

  test("a sibling reference inside the body is a LIVE AttrRef on the real instance", async () => {
    await writeComposite(ADMISSIBLE_BODY);
    await writeMain(CALL_WEBAPP);

    const result = await discover(srcDir, { fold: true, lexicons: [LEXICON_NAME] });

    const role = result.entities.get("webRole") as unknown as { props: { Description: unknown } };
    const ref = role.props.Description as { getLogicalName?: () => string | undefined; attribute?: string };
    expect(ref.getLogicalName?.()).toBe("webBucket");
    expect(ref.attribute).toBe("Arn");
  });

  test("interpreted output is byte-identical to run output (the #1023 acceptance differential)", async () => {
    await writeComposite(ADMISSIBLE_BODY);
    await writeMain(CALL_WEBAPP);

    const runResult = await build(srcDir, [specSerializer], undefined, { fold: false });
    resetFoldExecutionCounts();
    const foldResult = await build(srcDir, [specSerializer], undefined, {
      fold: true,
      lexicons: [LEXICON_NAME],
    });

    expect(runResult.errors).toEqual([]);
    expect(foldResult.errors).toEqual([]);
    // The comparison only means something if the fold half really interpreted.
    expect(foldExecutionCounts()).toMatchObject({ factoryInterpretations: 1, projectFactoryInvocations: 0 });

    const run = String(runResult.outputs.get(LEXICON_NAME));
    const folded = String(foldResult.outputs.get(LEXICON_NAME));
    expect(folded).toBe(run);
    // …and is non-vacuous: the spec carries both members, the `??` default, the
    // spread tags, the nested property construction and the cross-member ref.
    expect(run).toContain("webBucket");
    expect(run).toContain("managed-by");
    expect(run).toContain("Enabled");
    expect(run).toContain("GetAtt");
  });

  test("provenance is stamped from the source's own composite name", async () => {
    await writeComposite(ADMISSIBLE_BODY);
    await writeMain(CALL_WEBAPP);

    const result = await discover(srcDir, { fold: true, lexicons: [LEXICON_NAME] });

    const bucket = result.entities.get("webBucket") as unknown as Record<symbol, unknown>;
    const provenance = bucket[Symbol.for("chant.provenance")] as { composite?: string } | undefined;
    expect(provenance?.composite).toBe("WebApp");
  });

  test("a concise arrow body (no block) interprets", async () => {
    await writeComposite(`(props) => ({ bucket: new Bucket({ BucketName: props.name }) })`);
    await writeMain(CALL_WEBAPP);

    const result = await discover(srcDir, { fold: true, lexicons: [LEXICON_NAME] });

    expect(moduleRan()).toBeUndefined();
    expect(foldExecutionCounts().factoryInterpretations).toBe(1);
    expect([...result.entities.keys()]).toEqual(["webBucket"]);
  });

  test("a destructured props parameter interprets", async () => {
    await writeComposite(`({ name }) => {
      const bucket = new Bucket({ BucketName: name });
      return { bucket };
    }`);
    await writeMain(CALL_WEBAPP);

    const result = await discover(srcDir, { fold: true, lexicons: [LEXICON_NAME] });

    expect(moduleRan()).toBeUndefined();
    expect((result.entities.get("webBucket") as unknown as { props: { BucketName: string } }).props.BucketName).toBe(
      "data",
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // Nesting.
  // ───────────────────────────────────────────────────────────────────────

  test("a nested composite interprets recursively, and neither module is imported", async () => {
    await writeFile(
      join(testDir, "inner.ts"),
      `
        import { Bucket } from ${JSON.stringify(LEXICON)};
        import { Composite } from ${JSON.stringify(compositePath)};
        globalThis[${JSON.stringify(MODULE_MARKER)}] = true;
        export const Storage = Composite((props) => {
          const bucket = new Bucket({ BucketName: props.name });
          return { bucket };
        }, "Storage");
      `,
    );
    await writeFile(
      join(testDir, "outer.ts"),
      `
        import { Role } from ${JSON.stringify(LEXICON)};
        import { Composite } from ${JSON.stringify(compositePath)};
        import { Storage } from "./inner";
        globalThis[${JSON.stringify(MODULE_MARKER)}] = true;
        export const Platform = Composite((props) => {
          const storage = Storage({ name: props.name });
          const role = new Role({ Description: storage.bucket.Arn });
          return { storage, role };
        }, "Platform");
      `,
    );
    await writeMain(`
      import { Platform } from "../outer";
      export const plat = Platform({ name: "data" });
    `);

    const result = await discover(srcDir, { fold: true, lexicons: [LEXICON_NAME] });

    expect(result.errors).toEqual([]);
    expect(moduleRan(), "neither composite module may be imported").toBeUndefined();
    expect(foldExecutionCounts()).toMatchObject({ factoryInterpretations: 2, projectFactoryInvocations: 0 });
    // Nested expansion names members through both prefixes, exactly as the run
    // path's `expandComposite` does.
    expect([...result.entities.keys()].sort()).toEqual(["platRole", "platStorageBucket"]);
  });

  test("propagate() still merges shared props onto an interpreted instance", async () => {
    await writeComposite(ADMISSIBLE_BODY);
    await writeMain(`
      import { propagate } from ${JSON.stringify(compositePath)};
      import { WebApp } from "../composites";
      export const web = propagate(WebApp({ name: "data" }), { Description: "prod" });
    `);

    const result = await discover(srcDir, { fold: true, lexicons: [LEXICON_NAME] });

    expect(moduleRan()).toBeUndefined();
    const bucket = result.entities.get("webBucket") as unknown as { props: { Description?: string } };
    expect(bucket.props.Description).toBe("prod");
  });

  // ───────────────────────────────────────────────────────────────────────
  // What deliberately still invokes. Each case asserts the FALLBACK is exact:
  // the module ran, the file still folds, the entities are unchanged.
  // ───────────────────────────────────────────────────────────────────────

  test("a bare call to a plain exported function is not a registered composite (rule 2)", async () => {
    await writeComposite(ADMISSIBLE_BODY, `export function makeApp(props) { return WebApp({ name: props.name }); }`);
    await writeMain(`
      import { makeApp } from "../composites";
      export const web = makeApp({ name: "data" });
    `);

    const result = await discover(srcDir, { fold: true, lexicons: [LEXICON_NAME] });

    expect(moduleRan(), "a plain function must still be invoked").toBe(true);
    expect(foldExecutionCounts()).toMatchObject({ factoryInterpretations: 0, projectFactoryInvocations: 1 });
    expect([...result.entities.keys()].sort()).toEqual(["webBucket", "webRole"]);
  });

  test("a lexicon-package composite is deliberately not interpreted (rule 1)", async () => {
    // `LambdaApi` is a composite the aws lexicon itself publishes. It folds —
    // by invocation, in-process, which is exactly what #1093's allowlist
    // permits for a package the CLI has already loaded.
    await writeMain(`
      import { LambdaApi } from ${JSON.stringify(LEXICON)};
      export const api = LambdaApi({
        name: "fn",
        runtime: "nodejs20.x",
        handler: "index.handler",
        code: { ZipFile: "exports.handler = async () => ({});" },
      });
    `);

    const result = await discover(srcDir, { fold: true, lexicons: [LEXICON_NAME] });

    expect(result.errors).toEqual([]);
    expect(result.foldDecisions.find((d) => d.file.endsWith("main.ts"))?.mode).toBe("fold");
    expect(foldExecutionCounts()).toMatchObject({ factoryInterpretations: 0, projectFactoryInvocations: 0 });
    expect(foldExecutionCounts().factoryInvocations).toBe(1);
    expect(result.entities.size).toBeGreaterThan(0);
  });

  test("`Composite` shadowed by a project-local wrapper is not chant's (rule 2)", async () => {
    await writeFile(
      join(testDir, "composites.ts"),
      `
        import { Bucket } from ${JSON.stringify(LEXICON)};
        import { Composite } from "./local-composite";
        globalThis[${JSON.stringify(MODULE_MARKER)}] = true;
        export const WebApp = Composite((props) => {
          const bucket = new Bucket({ BucketName: props.name });
          return { bucket };
        }, "WebApp");
      `,
    );
    await writeFile(
      join(testDir, "local-composite.ts"),
      `
        import { Composite as ChantComposite } from ${JSON.stringify(compositePath)};
        export function Composite(factory, name) { return ChantComposite(factory, name); }
      `,
    );
    await writeMain(CALL_WEBAPP);

    const result = await discover(srcDir, { fold: true, lexicons: [LEXICON_NAME] });

    expect(moduleRan()).toBe(true);
    expect(foldExecutionCounts().factoryInterpretations).toBe(0);
    expect([...result.entities.keys()]).toEqual(["webBucket"]);
  });

  test("a body reference the defining module cannot resolve declines to invocation", async () => {
    // `sharedTags` comes from a sibling that does NOT fold, so the factory's
    // shape is admissible but the name is unresolvable — decline, then invoke.
    await writeFile(
      join(testDir, "unfoldable.ts"),
      `export const sharedTags = [{ Key: "a", Value: "b" }]; export default 1;`,
    );
    await writeFile(
      join(testDir, "composites.ts"),
      `
        import { Bucket } from ${JSON.stringify(LEXICON)};
        import { Composite } from ${JSON.stringify(compositePath)};
        import { sharedTags } from "./unfoldable";
        globalThis[${JSON.stringify(MODULE_MARKER)}] = true;
        export const WebApp = Composite((props) => {
          const bucket = new Bucket({ BucketName: props.name, Tags: sharedTags });
          return { bucket };
        }, "WebApp");
      `,
    );
    await writeMain(CALL_WEBAPP);

    const result = await discover(srcDir, { fold: true, lexicons: [LEXICON_NAME] });

    expect(moduleRan(), "an unresolvable body falls back to invoking, not to failing").toBe(true);
    expect(foldExecutionCounts().factoryInterpretations).toBe(0);
    expect((result.entities.get("webBucket") as unknown as { props: { Tags: unknown } }).props.Tags).toEqual([
      { Key: "a", Value: "b" },
    ]);
  });

  test("a module-level resource shared by every call declines rather than interpreting", async () => {
    await writeFile(
      join(testDir, "composites.ts"),
      `
        import { Bucket, Role } from ${JSON.stringify(LEXICON)};
        import { Composite } from ${JSON.stringify(compositePath)};
        globalThis[${JSON.stringify(MODULE_MARKER)}] = true;
        const sharedBucket = new Bucket({ BucketName: "shared" });
        export const WebApp = Composite((props) => {
          const role = new Role({ Description: sharedBucket.Arn, RoleName: props.name });
          return { role };
        }, "WebApp");
      `,
    );
    await writeMain(CALL_WEBAPP);

    const result = await discover(srcDir, { fold: true, lexicons: [LEXICON_NAME] });

    expect(moduleRan(), "a module-level singleton is the run path's to own").toBe(true);
    expect(foldExecutionCounts().factoryInterpretations).toBe(0);
    expect([...result.entities.keys()]).toEqual(["webRole"]);
  });

  test("a mutually recursive pair terminates instead of interpreting forever", async () => {
    await writeFile(
      join(testDir, "a.ts"),
      `
        import { Bucket } from ${JSON.stringify(LEXICON)};
        import { Composite } from ${JSON.stringify(compositePath)};
        import { B } from "./b";
        export const A = Composite((props) => {
          const inner = B({ name: props.name });
          const bucket = new Bucket({ BucketName: props.name });
          return { inner, bucket };
        }, "A");
      `,
    );
    await writeFile(
      join(testDir, "b.ts"),
      `
        import { Composite } from ${JSON.stringify(compositePath)};
        import { A } from "./a";
        export const B = Composite((props) => {
          const inner = A({ name: props.name });
          return { inner };
        }, "B");
      `,
    );
    await writeMain(`
      import { A } from "../a";
      export const app = A({ name: "data" });
    `);

    // The only requirement is that it TERMINATES with a decision, either way.
    const result = await discover(srcDir, { fold: true, lexicons: [LEXICON_NAME] });
    expect(result.foldDecisions.find((d) => d.file.endsWith("main.ts"))).toBeDefined();
  });

  // ───────────────────────────────────────────────────────────────────────
  // The --sandbox delta this issue exists for.
  // ───────────────────────────────────────────────────────────────────────

  test("--sandbox FOLDS an interpretable project composite (chant #1093's residual, closed)", async () => {
    await writeComposite(ADMISSIBLE_BODY);
    await writeMain(CALL_WEBAPP);

    const result = await discover(srcDir, { fold: true, sandbox: true, lexicons: [LEXICON_NAME] });

    expect(result.errors).toEqual([]);
    expect(
      result.foldDecisions.find((d) => d.file.endsWith("main.ts"))?.mode,
      "before #1023 this file was demoted to the sandboxed child",
    ).toBe("fold");
    expect(moduleRan()).toBeUndefined();
    expect([...result.entities.keys()].sort()).toEqual(["webBucket", "webRole"]);
  });

  test("--sandbox still demotes an INADMISSIBLE one, with the reason it had before", async () => {
    await writeComposite(INADMISSIBLE_BODY);
    await writeMain(CALL_WEBAPP);

    const result = await discover(srcDir, { fold: true, sandbox: true, lexicons: [LEXICON_NAME] });

    expect(result.errors).toEqual([]);
    const main = result.foldDecisions.find((d) => d.file.endsWith("main.ts"));
    expect(main?.mode).toBe("run");
    expect(main?.reason).toContain("--sandbox");
    expect(main?.reason).toContain("../composites");
    expect(moduleRan()).toBeUndefined();
    expect([...result.entities.keys()]).toEqual(["webBucket"]);
  });
});

/**
 * The shape half of the contract, on its own — the half a caller with no
 * module graph could evaluate. Kept as a direct table so the enumerated rules
 * in fold-import.ts's contract block have a line-by-line counterpart, rather
 * than being reachable only through a filesystem fixture.
 */
describe("findFactorySubsetViolation — the shape half of the contract (chant #1023)", () => {
  function factoryOf(source: string): ts.ArrowFunction | ts.FunctionExpression {
    const file = ts.createSourceFile("f.ts", `const F = ${source};`, ts.ScriptTarget.Latest, true);
    const statement = file.statements[0] as ts.VariableStatement;
    return statement.declarationList.declarations[0].initializer as ts.ArrowFunction;
  }

  const admissible = [
    ["a concise object body", `(props) => ({ b: new Bucket({ name: props.name }) })`],
    ["consts then return", `(props) => { const b = new Bucket({ n: props.n }); return { b }; }`],
    ["a nested construction in a property", `(props) => ({ b: new Bucket({ enc: new Rule({ alg: "AES" }) }) })`],
    ["a construction in an array", `(props) => ({ b: new Bucket({ rules: [new Rule({ alg: props.alg })] }) })`],
    ["a spread and a `??` default", `(props) => ({ b: new Bucket({ t: [...(props.t ?? []), "x"] }) })`],
    ["a ternary", `(props) => ({ b: new Bucket({ n: props.big ? "l" : "s" }) })`],
    ["a template", `(props) => ({ b: new Bucket({ n: \`p-\${props.n}\` }) })`],
    ["a tagged template", `(props) => ({ b: new Bucket({ n: Sub\`p-\${props.n}\` }) })`],
    ["a nested composite call", `(props) => { const i = Inner({ n: props.n }); return { i }; }`],
    ["a destructured props parameter", `({ n }) => ({ b: new Bucket({ n }) })`],
    ["a destructured const", `(props) => { const { a } = props; return { b: new Bucket({ a }) }; }`],
    ["no parameter at all", `() => ({ b: new Bucket({ n: "fixed" }) })`],
    ["a function expression", `function (props) { return { b: new Bucket({ n: props.n }) }; }`],
  ] as const;

  for (const [label, source] of admissible) {
    test(`admits ${label}`, () => {
      expect(findFactorySubsetViolation(factoryOf(source))).toBeUndefined();
    });
  }

  const rejected = [
    ["an `if` statement", `(props) => { if (props.n) { return {}; } return {}; }`, "IfStatement"],
    ["a `throw`", `(props) => { throw new Error("x"); const b = 1; return { b }; }`, "ThrowStatement"],
    ["a `for` loop", `(props) => { for (const x of props.n) {} return {}; }`, "ForOfStatement"],
    ["`let`", `(props) => { let b = 1; return { b }; }`, "`let`/`var`"],
    ["a bare expression statement", `(props) => { doThing(); return {}; }`, "ExpressionStatement"],
    ["an early return", `(props) => { return {}; const b = 1; }`, "early `return`"],
    ["a method call", `(props) => ({ b: new Bucket({ t: props.t.map(f) }) })`, "call"],
    ["a member-access constructor", `(props) => ({ b: new ns.Bucket({}) })`, "plain imported constructor"],
    ["a computed key", `(props) => ({ b: new Bucket({ [props.k]: 1 }) })`, "computed"],
    ["a dynamic element access", `(props) => ({ b: new Bucket({ n: props.t[props.i] }) })`, "dynamic element access"],
    ["an unsupported operator", `(props) => ({ b: new Bucket({ n: props.a % 2 }) })`, "unsupported binary"],
    ["an `await`", `(props) => ({ b: new Bucket({ n: await props.n }) })`, "unsupported expression"],
    ["two parameters", `(props, extra) => ({})`, "single props parameter"],
    ["a rest parameter", `(...props) => ({})`, "rest parameter"],
    ["a defaulted parameter", `(props = {}) => ({})`, "defaulted parameter"],
    ["a missing return", `(props) => { const b = new Bucket({}); }`, "must end in `return`"],
    ["an empty body", `(props) => {}`, "no members to interpret"],
  ] as const;

  for (const [label, source, fragment] of rejected) {
    test(`rejects ${label}`, () => {
      const violation = findFactorySubsetViolation(factoryOf(source));
      expect(violation, `${label} should be rejected`).toBeDefined();
      expect(violation).toContain(fragment);
    });
  }
});
