import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discover } from "./index";
import { build } from "../build";
import { walkValue } from "../serializer-walker";
import type { Declarable } from "../declarable";
import type { Serializer } from "../serializer";
import { foldExecutionCounts, resetFoldExecutionCounts } from "./fold-import";

/**
 * chant#3247 — a composite a lexicon PACKAGE publishes is interpreted like a
 * project composite, so its fields keep their parameter provenance, and a
 * composite behind a barrel re-export is found in the module that defines it.
 *
 * The real azure lexicon's `ActivityLogSink` is the package case: it is
 * exported from the package root through `src/index.ts` and
 * `src/composites/index.ts`, and its body is one `new PolicyAssignment({...})`
 * reading two props. The fixtures sit under the repo's `.cache/` so a bare
 * `@intentius/chant-lexicon-*` import resolves through this checkout's
 * `node_modules`, as it does for an installed project. chant's own package
 * specifiers are never `paths`-mapped, so the package route is the one taken.
 */

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "../../../..");
const compositePath = resolve(thisDir, "../composite");

const AZURE = "@intentius/chant-lexicon-azure";
const AWS = "@intentius/chant-lexicon-aws";

const MODULE_MARKER = "__chant3247CompositeModuleEvaluated";
type MarkerHost = Record<string, boolean | undefined>;
const moduleRan = (): boolean | undefined => (globalThis as unknown as MarkerHost)[MODULE_MARKER];
const clearMarker = (): void => {
  delete (globalThis as unknown as MarkerHost)[MODULE_MARKER];
};

/** Renders every entity's ref-resolved props, enough to compare a fold build with a run build byte for byte. */
function propsSerializer(name: string): Serializer {
  return {
    name,
    rulePrefix: "TEST",
    serialize: (entities) => {
      const names = new Map<Declarable, string>();
      for (const [entityName, entity] of entities) names.set(entity, entityName);
      const out: Record<string, unknown> = {};
      for (const [entityName, entity] of [...entities].sort(([a], [b]) => a.localeCompare(b))) {
        out[entityName] = {
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
}

let seq = 0;

describe("lexicon-package and re-exported composites are interpreted (chant#3247)", () => {
  let testDir: string;
  let srcDir: string;

  beforeEach(async () => {
    const dir = join(repoRoot, ".cache", `chant-3247-${process.pid}-${seq++}`);
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

  const CALL_SINK = `
    import { ActivityLogSink } from ${JSON.stringify(AZURE)};
    export const sink = ActivityLogSink({ workspaceId: "/subscriptions/s/workspaces/logs", location: "eastus" });
  `;

  test("a package composite reached through its barrel is interpreted, and every field keeps its origin", async () => {
    await writeFile(join(srcDir, "main.ts"), CALL_SINK);

    const folded = await build(srcDir, [propsSerializer("azure")], undefined, { fold: true, lexicons: ["azure"] });

    expect(folded.errors).toEqual([]);
    expect(foldExecutionCounts()).toMatchObject({ factoryInterpretations: 1, factoryInvocations: 0 });
    const fields = folded.foldProvenance.sinkAssignmentActivityLogSink!.fields;
    const param = (...parameters: string[]) => ({
      kind: "composite-parameter",
      composite: "ActivityLogSink",
      instance: "sink",
      parameters,
    });
    expect(fields.location).toEqual(param("location"));
    expect(fields["parameters.logAnalytics.value"]).toEqual(param("workspaceId"));
    expect(fields.name).toEqual({ kind: "composite-literal", composite: "ActivityLogSink", instance: "sink" });

    // Interpreting is not a second evaluation: the run path writes the same bytes.
    const run = await build(srcDir, [propsSerializer("azure")], undefined, { fold: false, lexicons: ["azure"] });
    expect(run.errors).toEqual([]);
    expect(folded.outputs.get("azure")).toEqual(run.outputs.get("azure"));
    expect(run.foldProvenance.sinkAssignmentActivityLogSink!.fields.location).toEqual({
      kind: "unknown",
      reason: "composite-not-interpreted",
    });
  });

  test("under --sandbox the package's own imports are trusted, so it is still interpreted", async () => {
    await writeFile(join(srcDir, "main.ts"), CALL_SINK);

    const result = await discover(srcDir, { fold: true, sandbox: true, lexicons: ["azure"] });

    expect(result.errors).toEqual([]);
    expect(result.foldDecisions.find((d) => d.file.endsWith("main.ts"))?.mode).toBe("fold");
    expect(foldExecutionCounts()).toMatchObject({ factoryInterpretations: 1, factoryInvocations: 0 });
  });

  test("a lexicon the build did not load is not followed", async () => {
    await writeFile(join(srcDir, "main.ts"), CALL_SINK);

    await discover(srcDir, { fold: true, lexicons: ["aws"] });

    expect(foldExecutionCounts().factoryInterpretations).toBe(0);
  });

  test("a project barrel's `export *` and renamed `export { } from` reach the defining module", async () => {
    await mkdir(join(testDir, "lib", "composites"), { recursive: true });
    await writeFile(
      join(testDir, "lib", "composites", "web.ts"),
      `
        import { Bucket } from ${JSON.stringify(AWS)};
        import { Composite } from ${JSON.stringify(compositePath)};
        globalThis[${JSON.stringify(MODULE_MARKER)}] = true;
        export const WebApp = Composite((props) => {
          const bucket = new Bucket({ BucketName: props.name });
          return { bucket };
        }, "WebApp");
      `,
    );
    await writeFile(join(testDir, "lib", "composites", "index.ts"), `export * from "./web";\n`);
    await writeFile(
      join(testDir, "lib", "index.ts"),
      `export * from "./composites/index";\nexport { WebApp as Site } from "./composites/web";\n`,
    );
    await writeFile(
      join(srcDir, "main.ts"),
      `
        import { WebApp, Site } from "../lib";
        export const web = WebApp({ name: "data" });
        export const site = Site({ name: "site" });
      `,
    );

    const result = await discover(srcDir, { fold: true, lexicons: ["aws"] });

    expect(result.errors).toEqual([]);
    expect(moduleRan(), "the defining module was read, never imported").toBeUndefined();
    expect(foldExecutionCounts()).toMatchObject({ factoryInterpretations: 2, factoryInvocations: 0 });
    expect([...result.entities.keys()].sort()).toEqual(["siteBucket", "webBucket"]);
  });

  /** A stand-in lexicon package installed in the fixture's own `node_modules`. */
  async function installFakeLexicon(name: string, files: Record<string, string>, exportsTarget: string): Promise<void> {
    const pkgDir = join(testDir, "node_modules", "@intentius", `chant-lexicon-${name}`);
    for (const [file, source] of Object.entries(files)) {
      await mkdir(dirname(join(pkgDir, file)), { recursive: true });
      await writeFile(join(pkgDir, file), source);
    }
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: `@intentius/chant-lexicon-${name}`, type: "module", exports: { ".": exportsTarget } }),
    );
  }

  const WEBAPP_DEFINITION = `
    import { Bucket } from ${JSON.stringify(AWS)};
    import { Composite } from "@intentius/chant/composite";
    globalThis[${JSON.stringify(MODULE_MARKER)}] = true;
    export const WebApp = Composite((props) => {
      const bucket = new Bucket({ BucketName: props.name });
      return { bucket };
    }, "WebApp");
  `;

  test("a package whose module is compiled JavaScript is invoked, not interpreted", async () => {
    // The body is admissible (a single expression), so only the module's build
    // shape keeps it from being interpreted.
    await installFakeLexicon(
      "fakejs3247",
      {
        "dist/index.js": `
          import { Composite } from "@intentius/chant/composite";
          globalThis[${JSON.stringify(MODULE_MARKER)}] = true;
          export const Wrap = Composite((props) => ({ bucket: props.bucket }), "Wrap");
        `,
      },
      "./dist/index.js",
    );
    await writeFile(
      join(srcDir, "main.ts"),
      `
        import { Bucket } from ${JSON.stringify(AWS)};
        import { Wrap } from "@intentius/chant-lexicon-fakejs3247";
        export const web = Wrap({ bucket: new Bucket({ BucketName: "data" }) });
      `,
    );

    await discover(srcDir, { fold: true, lexicons: ["aws", "fakejs3247"] });

    // Declined before the module was parsed, so the call went to invocation.
    // Whether that import then succeeds is the stand-in's business: plain Node
    // cannot load chant's TypeScript source from a `.js` file, so it is not
    // asserted here.
    expect(foldExecutionCounts().factoryInterpretations).toBe(0);
  });

  test("a package re-export that leaves the package's directory is not followed", async () => {
    await mkdir(join(testDir, "shared"), { recursive: true });
    await writeFile(join(testDir, "shared", "web.ts"), WEBAPP_DEFINITION);
    await installFakeLexicon(
      "fakeescape3247",
      { "src/index.ts": `export { WebApp } from "../../../../shared/web";\n` },
      "./src/index.ts",
    );
    await writeFile(
      join(srcDir, "main.ts"),
      `import { WebApp } from "@intentius/chant-lexicon-fakeescape3247";\nexport const web = WebApp({ name: "data" });\n`,
    );

    const result = await discover(srcDir, { fold: true, lexicons: ["aws", "fakeescape3247"] });

    expect(result.errors).toEqual([]);
    expect(foldExecutionCounts().factoryInterpretations).toBe(0);
  });

  test("the same package composite, TypeScript source, is interpreted", async () => {
    await installFakeLexicon(
      "fakets3247",
      { "src/index.ts": `export * from "./composites/index";\n`, "src/composites/index.ts": `export * from "./web";\n`, "src/composites/web.ts": WEBAPP_DEFINITION },
      "./src/index.ts",
    );
    await writeFile(
      join(srcDir, "main.ts"),
      `import { WebApp } from "@intentius/chant-lexicon-fakets3247";\nexport const web = WebApp({ name: "data" });\n`,
    );

    const result = await discover(srcDir, { fold: true, lexicons: ["aws", "fakets3247"] });

    expect(result.errors).toEqual([]);
    expect(foldExecutionCounts()).toMatchObject({ factoryInterpretations: 1, factoryInvocations: 0 });
    expect([...result.entities.keys()]).toEqual(["webBucket"]);
  });
});
