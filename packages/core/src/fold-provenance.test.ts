/**
 * chant #2161 — fold provenance, and the return leg that reads it.
 *
 * Two altitudes. The unit half pins the four-way classification and the
 * resolutions it licenses; the build half drives a REAL fold build over a
 * fixture whose composite parameterizes some fields and fixes others, so the
 * origins come from `discovery/fold-import.ts`'s interpretation rather than
 * from a hand-written provenance record.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build";
import { getProvenance, originOfPath, type EntityProvenance } from "./provenance";
import type { DeepEntityDrift } from "./lifecycle/deep-diff";
import {
  classifyFieldOrigin,
  emittedFieldPaths,
  foldProvenanceOfEntity,
  describeCompositeArguments,
  describeFoldFieldOrigin,
  resolveDeepDrift,
  resolveDriftedField,
} from "./fold-provenance";
import type { Serializer } from "./serializer";
import type { Declarable } from "./declarable";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "../../..");
const compositePath = resolve(thisDir, "./composite");

const LEXICON = "@intentius/chant-lexicon-aws";
const LEXICON_NAME = "aws";

/** Renders nothing but the entity names, so the exclusion assertions below have a document to look at. */
const namesSerializer: Serializer = {
  name: LEXICON_NAME,
  rulePrefix: "TEST",
  serialize: (entities) => JSON.stringify({ resources: [...entities.keys()].sort() }, null, 2),
};

// ─────────────────────────────────────────────────────────────────────────
// The unit half.
// ─────────────────────────────────────────────────────────────────────────

describe("emittedFieldPaths", () => {
  test("dots through plain objects and attributes anything else whole", () => {
    expect(
      emittedFieldPaths({
        BucketName: "assets",
        VersioningConfiguration: { Status: "Enabled" },
        Tags: [{ Key: "env", Value: "prod" }],
        Empty: {},
      }),
    ).toEqual(["BucketName", "Empty", "Tags", "VersioningConfiguration.Status"]);
  });

  test("an undefined value emits no path", () => {
    expect(emittedFieldPaths({ a: 1, b: undefined })).toEqual(["a"]);
  });

  test("props that are not an object at all emit nothing", () => {
    expect(emittedFieldPaths(undefined)).toEqual([]);
    expect(emittedFieldPaths({})).toEqual([]);
  });
});

describe("classifyFieldOrigin", () => {
  const composite: EntityProvenance = { sourceFile: "/p/src/app.ts", composite: "WebService", compositeInstance: "web" };
  const authored: EntityProvenance = { sourceFile: "/p/src/app.ts" };

  test("a recorded composite parameter carries the parameter paths and the call", () => {
    expect(
      classifyFieldOrigin({ kind: "composite-parameter", composite: "WebService", parameters: ["name"] }, composite),
    ).toEqual({ kind: "composite-parameter", composite: "WebService", instance: "web", parameters: ["name"] });
  });

  test("a recorded composite literal says which composite fixes it", () => {
    expect(classifyFieldOrigin({ kind: "composite-literal", composite: "WebService" }, composite)).toMatchObject({
      kind: "composite-literal",
      composite: "WebService",
      instance: "web",
    });
  });

  test("authored and build-param are both the author's own declaration", () => {
    expect(classifyFieldOrigin({ kind: "authored" }, authored)).toEqual({ kind: "direct" });
    expect(classifyFieldOrigin({ kind: "build-param", params: ["tier"] }, authored)).toEqual({ kind: "direct" });
  });

  test("the COARSE composite origin is unknown, never a direct declaration", () => {
    expect(classifyFieldOrigin({ kind: "composite", composite: "WebService", instance: "web" }, composite)).toEqual({
      kind: "unknown",
      reason: "composite-not-interpreted",
    });
  });

  test("no origin on an entity a composite expanded is unknown, never a direct declaration", () => {
    expect(classifyFieldOrigin(undefined, composite)).toEqual({
      kind: "unknown",
      reason: "composite-not-interpreted",
    });
  });

  test("a host origin is unknown with that reason, never a direct declaration (typescript-as-data#248)", () => {
    expect(classifyFieldOrigin({ kind: "host", reason: "host-call" }, authored)).toEqual({
      kind: "unknown",
      reason: "host-call",
    });
    expect(classifyFieldOrigin({ kind: "host", reason: "host-value" }, authored)).toEqual({
      kind: "unknown",
      reason: "host-value",
    });
  });

  test("no origin on an entity no composite expanded is a direct declaration", () => {
    expect(classifyFieldOrigin(undefined, authored)).toEqual({ kind: "direct" });
  });

  test("no provenance record at all is unknown, because not even the composite question is answerable", () => {
    expect(classifyFieldOrigin(undefined, undefined)).toEqual({ kind: "unknown", reason: "no-provenance" });
    expect(classifyFieldOrigin({ kind: "authored" }, undefined)).toEqual({ kind: "unknown", reason: "no-provenance" });
  });
});

describe("foldProvenanceOfEntity", () => {
  const entity = {
    lexicon: "aws",
    entityType: "AWS::S3::Bucket",
    props: { BucketName: "assets", VersioningConfiguration: { Status: "Enabled" } },
    [Symbol.for("chant.declarable")]: true,
  } as unknown as Declarable;

  test("every emitted path is present, unattributed ones included", () => {
    const record = foldProvenanceOfEntity(entity, {
      sourceFile: "/p/src/app.ts",
      composite: "WebService",
      compositeInstance: "web",
      paths: { BucketName: { kind: "composite-parameter", composite: "WebService", parameters: ["name"] } },
    });

    expect(record).toEqual({
      sourceFile: "/p/src/app.ts",
      composite: "WebService",
      instance: "web",
      fields: {
        BucketName: { kind: "composite-parameter", composite: "WebService", instance: "web", parameters: ["name"] },
        // Nothing recorded for it, and a composite made the entity: unknown.
        "VersioningConfiguration.Status": { kind: "unknown", reason: "composite-not-interpreted" },
      },
    });
  });

  test("an entity with no props at all has no record", () => {
    const output = {
      lexicon: "aws",
      entityType: "AWS::Output",
      [Symbol.for("chant.declarable")]: true,
    } as unknown as Declarable;
    expect(foldProvenanceOfEntity(output, { sourceFile: "/p/src/app.ts" })).toBeUndefined();
  });
});

describe("resolveDriftedField", () => {
  const compositeProv: EntityProvenance = {
    sourceFile: "src/app.infra.ts",
    composite: "WebService",
    compositeInstance: "web",
  };

  test("a parameter is proposed by name, with the file and the composite call", () => {
    const resolved = resolveDriftedField({
      entity: "webBucket",
      path: "Tags[#tier].Value",
      declared: "prod",
      live: "staging",
      origin: { kind: "composite-parameter", composite: "WebService", parameters: ["tier"] },
      provenance: compositeProv,
    });

    expect(resolved.resolution.kind).toBe("propose-parameter");
    if (resolved.resolution.kind !== "propose-parameter") throw new Error("unreachable");
    expect(resolved.resolution.parameters).toEqual(["tier"]);
    expect(resolved.resolution.sourceFile).toBe("src/app.infra.ts");
    expect(resolved.resolution.composite).toBe("WebService");
    expect(resolved.resolution.instance).toBe("web");
    // The file, the composite call and the parameter path, all three named.
    expect(resolved.resolution.description).toContain("src/app.infra.ts");
    expect(resolved.resolution.description).toContain("`web` call of composite WebService");
    expect(resolved.resolution.description).toContain("`tier`");
    expect(resolved.resolution.description).toContain("The composite stays.");
  });

  test("a field the composite fixes is a NAMED refusal, and proposes no resource change", () => {
    const resolved = resolveDriftedField({
      entity: "webBucket",
      path: "VersioningConfiguration.Status",
      declared: "Enabled",
      live: "Suspended",
      origin: { kind: "composite-literal", composite: "WebService" },
      provenance: compositeProv,
    });

    expect(resolved.resolution.kind).toBe("refuse-fixed");
    if (resolved.resolution.kind !== "refuse-fixed") throw new Error("unreachable");
    expect(resolved.resolution.composite).toBe("WebService");
    expect(resolved.resolution.description).toMatch(/^refused: /);
    expect(resolved.resolution.description).toContain("VersioningConfiguration.Status");
    expect(resolved.resolution.description).toContain("WebService");
    expect(resolved.resolution.description).toContain("Parameterize the field");
    expect(resolved.resolution.description).toContain("stop using the composite here");
  });

  test("a direct declaration keeps today's behaviour", () => {
    const resolved = resolveDriftedField({
      entity: "logs",
      path: "BucketName",
      declared: "logs",
      live: "logs-2",
      origin: { kind: "authored" },
      provenance: { sourceFile: "src/app.infra.ts" },
    });
    expect(resolved.resolution.kind).toBe("edit-declaration");
    expect(resolved.resolution.description).toContain("change the declared value of `BucketName`");
  });

  test("an unknown origin falls back to today's behaviour AND says that is what happened", () => {
    const resolved = resolveDriftedField({
      entity: "legacyBucket",
      path: "BucketName",
      declared: "old",
      live: "older",
      origin: { kind: "composite", composite: "LegacyService", instance: "legacy" },
      provenance: { sourceFile: "src/app.infra.ts", composite: "LegacyService", compositeInstance: "legacy" },
    });

    expect(resolved.origin).toEqual({ kind: "unknown", reason: "composite-not-interpreted" });
    expect(resolved.resolution.kind).toBe("fall-back");
    if (resolved.resolution.kind !== "fall-back") throw new Error("unreachable");
    expect(resolved.resolution.reason).toBe("composite-not-interpreted");
    expect(resolved.resolution.description).toContain("origin unknown");
    expect(resolved.resolution.description).toContain("falling back to changing the declared value");
  });

  test("an absent field still resolves by origin", () => {
    const resolved = resolveDriftedField({
      entity: "webRole",
      path: "Path",
      declared: "/service/",
      origin: { kind: "composite-parameter", composite: "WebService", parameters: ["iam.path"] },
      provenance: compositeProv,
    });
    expect(resolved.resolution.kind).toBe("propose-parameter");
    expect(resolved.resolution.description).toContain("unset");
  });
});

describe("the drift report's origin line (#3597)", () => {
  const call = { file: "/p/src/app.ts", line: 10, column: 20 };
  const compositeProv: EntityProvenance = {
    sourceFile: "/p/src/app.ts",
    composite: "WebApp",
    compositeInstance: "web",
    compositeCall: call,
  };
  const base = { entity: "webDeployment", entityType: "Deployment", root: "/p", declared: 3, live: 5 };

  test("a composite parameter names the call, the argument as written, and its file and line", () => {
    const resolved = resolveDriftedField({
      ...base,
      path: "spec.replicas",
      origin: {
        kind: "composite-parameter",
        composite: "WebApp",
        parameters: ["replicas"],
        arguments: [{ parameter: "replicas", file: "/p/src/app.ts", line: 12, column: 3, text: "replicas: 3" }],
      },
      provenance: compositeProv,
    });
    expect(resolved.summary).toBe(
      "spec.replicas on Deployment webDeployment comes from WebApp({ replicas: 3 }) at src/app.ts:12",
    );
    expect(resolved.resolution.description).toContain("the `web` call of composite WebApp at src/app.ts:12");
    // The origin object carries the locations, for --json.
    expect(resolved.origin).toEqual({
      kind: "composite-parameter",
      composite: "WebApp",
      instance: "web",
      parameters: ["replicas"],
      call,
      arguments: [{ parameter: "replicas", file: "/p/src/app.ts", line: 12, column: 3, text: "replicas: 3" }],
    });
  });

  test("a nested parameter is shown nested, and a parameter the call does not write says so", () => {
    expect(describeCompositeArguments("WebService", [
      { parameter: "iam.path", file: "/p/a.ts", line: 4, column: 9, text: 'path: "/x/"' },
    ])).toBe('WebService({ iam: { path: "/x/" } })');

    const resolved = resolveDriftedField({
      ...base,
      path: "spec.template.spec.containers[#web].image",
      origin: {
        kind: "composite-parameter",
        composite: "WebApp",
        parameters: ["image"],
        arguments: [{ parameter: "image", ...call }],
      },
      provenance: compositeProv,
    });
    expect(resolved.summary).toBe(
      "spec.template.spec.containers[#web].image on Deployment webDeployment comes from WebApp(...) " +
        "at src/app.ts:10 (parameter image, not written at the call)",
    );
  });

  test("a composite literal says the composite fixes it, at the call", () => {
    const resolved = resolveDriftedField({
      ...base,
      path: "spec.strategy.type",
      origin: { kind: "composite-literal", composite: "WebApp" },
      provenance: compositeProv,
    });
    expect(resolved.summary).toBe(
      "spec.strategy.type on Deployment webDeployment is fixed inside composite WebApp; " +
        "no argument to the call at src/app.ts:10 moves it",
    );
    expect(resolved.resolution.description).toContain("fixed by the `web` call of composite WebApp at src/app.ts:10");
  });

  test("a direct declaration says direct, and the resolution is today's", () => {
    const resolved = resolveDriftedField({
      ...base,
      entity: "worker",
      path: "spec.replicas",
      provenance: { sourceFile: "/p/src/app.ts" },
    });
    expect(resolved.origin).toEqual({ kind: "direct" });
    expect(resolved.summary).toBe("spec.replicas on Deployment worker is declared directly in src/app.ts");
    expect(resolved.resolution).toEqual({
      kind: "edit-declaration",
      sourceFile: "/p/src/app.ts",
      description: "change the declared value of `spec.replicas` in src/app.ts from 3 to 5.",
    });
  });

  test("an unknown origin says unknown and why, and never reads as direct", () => {
    for (const [provenance, why] of [
      [{ sourceFile: "/p/src/app.ts", composite: "WebApp", compositeInstance: "web" }, "did not interpret"],
      [undefined, "recorded no provenance"],
    ] as const) {
      const resolved = resolveDriftedField({ ...base, path: "spec.replicas", ...(provenance ? { provenance } : {}) });
      expect(resolved.origin.kind).toBe("unknown");
      expect(resolved.summary).toMatch(/^spec\.replicas on Deployment webDeployment has an unknown origin: /);
      expect(resolved.summary).toContain(why);
      expect(resolved.summary).not.toContain("direct");
      expect(resolved.resolution.kind).toBe("fall-back");
    }
  });

  test("a file outside the project root is printed as recorded", () => {
    const resolved = resolveDriftedField({
      ...base,
      root: "/elsewhere",
      path: "spec.replicas",
      origin: {
        kind: "composite-parameter",
        composite: "WebApp",
        parameters: ["replicas"],
        arguments: [{ parameter: "replicas", file: "/p/src/app.ts", line: 12, column: 3, text: "replicas: 3" }],
      },
      provenance: compositeProv,
    });
    expect(resolved.summary).toContain("at /p/src/app.ts:12");
  });
});

describe("resolveDeepDrift", () => {
  test("reads the drifted list and nothing else", () => {
    const verdicts = resolveDeepDrift(
      [
        {
          name: "webBucket",
          type: "AWS::S3::Bucket",
          changes: [
            {
              path: "BucketName",
              kind: "changed",
              declared: "data",
              live: "data-2",
              origin: { kind: "composite-parameter", composite: "WebService", parameters: ["name"] },
            },
            {
              path: "VersioningConfiguration.Status",
              kind: "changed",
              declared: "Enabled",
              live: "Suspended",
              origin: { kind: "composite-literal", composite: "WebService" },
            },
          ],
        },
      ],
      () => ({ sourceFile: "src/app.infra.ts", composite: "WebService", compositeInstance: "web" }),
    );

    expect(verdicts.map((v) => v.resolution.kind)).toEqual(["propose-parameter", "refuse-fixed"]);
  });
});

describe("describeFoldFieldOrigin", () => {
  test("renders each of the four kinds", () => {
    expect(
      describeFoldFieldOrigin({ kind: "composite-parameter", composite: "W", instance: "web", parameters: ["a", "b"] }),
    ).toBe("parameter a, b of the `web` call of composite W");
    expect(describeFoldFieldOrigin({ kind: "composite-literal", composite: "W", instance: "web" })).toBe(
      "fixed by the `web` call of composite W",
    );
    expect(describeFoldFieldOrigin({ kind: "direct" })).toBe("declared directly");
    expect(describeFoldFieldOrigin({ kind: "unknown", reason: "no-provenance" })).toContain("origin unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The build half: one fixture, all four origin kinds.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The fixture composite. `WebService` is inside `fold-import.ts`'s admissible
 * subset, so its body is interpreted and every member property is attributed:
 *
 *  - `BucketName` and `Path` read a parameter directly, one of them nested
 *    (`props.iam.path`);
 *  - `RoleName` reads one through a body `const`;
 *  - `Tags` reads one from inside an array of object literals;
 *  - `VersioningConfiguration.Status` and `Description` read none, so the
 *    composite fixes them.
 *
 * `LegacyService` is one `if` outside the subset, so it is invoked rather than
 * interpreted and its fields are honestly unknown.
 */
const COMPOSITES = `
  import { Bucket, Role } from ${JSON.stringify(LEXICON)};
  import { Composite } from ${JSON.stringify(compositePath)};

  export const WebService = Composite((props) => {
    const roleName = \`role-for-\${props.name}\`;
    const bucket = new Bucket({
      BucketName: props.name,
      VersioningConfiguration: { Status: "Enabled" },
      Tags: [{ Key: "tier", Value: props.tier }],
    });
    const role = new Role({
      RoleName: roleName,
      Description: bucket.Arn,
      Path: props.iam.path,
    });
    return { bucket, role };
  }, "WebService");

  export const LegacyService = Composite((props) => {
    if (!props.name) { throw new Error("name required"); }
    const bucket = new Bucket({ BucketName: props.name, ObjectLockEnabled: true });
    return { bucket };
  }, "LegacyService");
`;

const MAIN = `
  import { Bucket } from ${JSON.stringify(LEXICON)};
  import { WebService } from "../composites";

  export const logs = new Bucket({ BucketName: "logs" });
  export const web = WebService({ name: "data", tier: "prod", iam: { path: "/service/" } });
`;

/**
 * `LegacyService` sits in its own file since spec 2.0.
 *
 * It is one `if` outside the subset, so step 4 declines and `F-Call` step 5
 * makes the declarator `run`. A verdict is per file, so leaving it beside
 * `web` took the whole file to run and every field's origin with it — the
 * interpreted composite's provenance is only observable in a file that folds.
 * `executing` is the other way to keep it, and this fixture wants the default.
 */
const LEGACY_MAIN = `
  import { LegacyService } from "../composites";

  export const legacy = LegacyService({ name: "old" });
`;

let seq = 0;

describe("fold provenance over a real composite build (#2161)", () => {
  let testDir: string;
  let srcDir: string;

  beforeEach(async () => {
    // Inside the repo (`.cache/` is gitignored) rather than the system tmpdir,
    // because the fixture imports the REAL lexicon package and that only
    // resolves from a directory whose `node_modules` walk reaches this
    // checkout's. Same reason `discovery/fold-composite.test.ts` does it.
    const dir = join(repoRoot, ".cache", `chant-2161-${process.pid}-${seq++}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    testDir = await realpath(dir);
    srcDir = join(testDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(testDir, "composites.ts"), COMPOSITES);
    await writeFile(join(srcDir, "main.ts"), MAIN);
    await writeFile(join(srcDir, "legacy.ts"), LEGACY_MAIN);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("the fixture proves all four origin kinds", async () => {
    const result = await build(srcDir, [namesSerializer], undefined, {
      fold: true,
      lexicons: [LEXICON_NAME],
    });

    expect(result.errors).toEqual([]);
    expect(Object.keys(result.foldProvenance).sort()).toEqual([
      "legacyBucket",
      "logs",
      "webBucket",
      "webRole",
    ]);

    // 1. A field the composite PARAMETERIZES, including a nested parameter
    //    path, one read through a body `const`, and one read from inside an
    //    array literal.
    expect(result.foldProvenance.webBucket.fields.BucketName).toMatchObject({
      kind: "composite-parameter",
      composite: "WebService",
      instance: "web",
      parameters: ["name"],
    });
    expect(result.foldProvenance.webBucket.fields.Tags).toMatchObject({
      kind: "composite-parameter",
      composite: "WebService",
      instance: "web",
      parameters: ["tier"],
    });
    expect(result.foldProvenance.webRole.fields.RoleName).toMatchObject({
      kind: "composite-parameter",
      composite: "WebService",
      instance: "web",
      parameters: ["name"],
    });
    expect(result.foldProvenance.webRole.fields.Path).toMatchObject({
      kind: "composite-parameter",
      composite: "WebService",
      instance: "web",
      parameters: ["iam.path"],
    });

    // 2. A field the composite FIXES.
    expect(result.foldProvenance.webBucket.fields["VersioningConfiguration.Status"]).toMatchObject({
      kind: "composite-literal",
      composite: "WebService",
      instance: "web",
    });
    expect(result.foldProvenance.webRole.fields.Description).toMatchObject({
      kind: "composite-literal",
      composite: "WebService",
      instance: "web",
    });

    // 3. A DIRECT declaration, alongside the composite in the same file.
    expect(result.foldProvenance.logs.fields.BucketName).toEqual({ kind: "direct" });
    expect(result.foldProvenance.logs.composite).toBeUndefined();

    // 4. UNKNOWN: a composite this build expanded without interpreting.
    expect(result.foldProvenance.legacyBucket.fields.BucketName).toEqual({
      kind: "unknown",
      reason: "composite-not-interpreted",
    });
    expect(result.foldProvenance.legacyBucket.composite).toBe("LegacyService");

    // The file and the composite call, for the proposal to name.
    expect(result.foldProvenance.webBucket.sourceFile).toContain("main.ts");
    expect(result.foldProvenance.webBucket.instance).toBe("web");
  });

  test("the return leg proposes a parameter change, refuses a fixed field, and says when it fell back", async () => {
    const result = await build(srcDir, [namesSerializer], undefined, {
      fold: true,
      lexicons: [LEXICON_NAME],
    });
    const provenanceOf = (name: string): EntityProvenance | undefined => {
      const entity = result.entities.get(name);
      return entity ? getProvenance(entity) : undefined;
    };

    /**
     * One drift row, with its `origin` resolved off the entity's own record
     * the way `lifecycle/deep-diff.ts` resolves it with `originOfPath`. That is
     * the only wiring the return leg needs, and doing it here keeps this test
     * about the resolutions rather than about a live cloud.
     */
    const drift = (name: string, path: string, declared: unknown, live: unknown): DeepEntityDrift => {
      const origin = originOfPath(provenanceOf(name)?.paths, path);
      return {
        name,
        type: "AWS::S3::Bucket",
        changes: [{ path, kind: "changed", declared, live, ...(origin ? { origin } : {}) }],
      };
    };

    const verdicts = resolveDeepDrift(
      [
        drift("webBucket", "BucketName", "data", "data-renamed"),
        drift("webBucket", "VersioningConfiguration.Status", "Enabled", "Suspended"),
        drift("legacyBucket", "BucketName", "old", "older"),
        drift("logs", "BucketName", "logs", "logs-archive"),
      ],
      provenanceOf,
    );

    // A parameter: proposed, naming the file, the composite call and the path.
    expect(verdicts[0].resolution.kind).toBe("propose-parameter");
    if (verdicts[0].resolution.kind !== "propose-parameter") throw new Error("unreachable");
    expect(verdicts[0].resolution.parameters).toEqual(["name"]);
    expect(verdicts[0].resolution.instance).toBe("web");
    expect(verdicts[0].resolution.sourceFile).toContain("main.ts");
    expect(verdicts[0].resolution.description).toContain("`name`");

    // A field the composite fixes: a NAMED refusal, and no flat resource change.
    expect(verdicts[1].resolution.kind).toBe("refuse-fixed");
    expect(verdicts[1].resolution.description).toContain("fixed by the `web` call of composite WebService");

    // Unknown: today's behaviour, and it says so.
    expect(verdicts[2].origin).toEqual({ kind: "unknown", reason: "composite-not-interpreted" });
    expect(verdicts[2].resolution.kind).toBe("fall-back");
    expect(verdicts[2].resolution.description).toContain("origin unknown");

    // A direct declaration: today's behaviour, unchanged and unremarked.
    expect(verdicts[3].resolution.kind).toBe("edit-declaration");
  });

  test("the build records where the composite call and each argument were written (#3597)", async () => {
    const result = await build(srcDir, [namesSerializer], undefined, {
      fold: true,
      lexicons: [LEXICON_NAME],
    });
    expect(result.errors).toEqual([]);
    const main = join(srcDir, "main.ts");
    const lines = MAIN.split("\n");
    const lineOf = (needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;
    const columnOf = (needle: string) => (lines.find((l) => l.includes(needle)) as string).indexOf(needle) + 1;
    const call = { file: main, line: lineOf("WebService({"), column: columnOf("WebService({") };

    expect(result.foldProvenance.webBucket.compositeCall).toEqual(call);
    expect(result.foldProvenance.webRole.compositeCall).toEqual(call);
    expect(result.foldProvenance.webBucket.fields.BucketName).toEqual({
      kind: "composite-parameter",
      composite: "WebService",
      instance: "web",
      parameters: ["name"],
      call,
      arguments: [{ parameter: "name", file: main, line: call.line, column: columnOf('name: "data"'), text: 'name: "data"' }],
    });
    expect(result.foldProvenance.webRole.fields.Path).toMatchObject({
      arguments: [{ parameter: "iam.path", line: call.line, column: columnOf('path: "/service/"'), text: 'path: "/service/"' }],
    });
    expect(result.foldProvenance.webBucket.fields["VersioningConfiguration.Status"]).toEqual({
      kind: "composite-literal",
      composite: "WebService",
      instance: "web",
      call,
    });

    // A direct declaration and an uninterpreted composite record no call.
    expect(result.foldProvenance.logs.compositeCall).toBeUndefined();
    expect(result.foldProvenance.legacyBucket.compositeCall).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// chant #3212 — a registered tag inside a composite factory.
// ─────────────────────────────────────────────────────────────────────────

const runtimePath = resolve(thisDir, "./runtime");
const provenancePath = resolve(thisDir, "./provenance");

/**
 * A SQL-shaped tag, the shape the sql lexicon's `table` takes: it builds one
 * entity out of its text and reports, per interpolation, which of the entity's
 * fields that interpolation fed. An interpolated entity is a reference and
 * feeds nothing the author typed, so it reports no field.
 */
const TAGS = `
  import { createResource } from ${JSON.stringify(runtimePath)};
  import { setInterpolationFields } from ${JSON.stringify(provenancePath)};
  const Table = createResource("Test::Table", ${JSON.stringify(LEXICON_NAME)}, {});
  const CLAUSE = { TABLE: "name", "ENGINE =": "engine", "ORDER BY": "orderBy", TTL: "ttl", COMMENT: "comment" };

  export function table(strings, ...values) {
    const isEntity = (v) => typeof v === "object" && v !== null && "props" in v;
    let ddl = strings[0];
    const fields = values.map((v, i) => {
      ddl += (isEntity(v) ? v.props.name : String(v)) + strings[i + 1];
      if (isEntity(v)) return [];
      const at = (k) => strings[i].lastIndexOf(k);
      const clause = Object.keys(CLAUSE).sort((a, b) => at(b) - at(a))[0];
      return at(clause) >= 0 ? [CLAUSE[clause], "ddl"] : ["ddl"];
    });
    const m = /CREATE TABLE (\\w+) ENGINE = (\\w+) ORDER BY (\\w+)(?: TTL (.+?))?(?: COMMENT (\\w+))?$/.exec(ddl);
    if (!m) throw new Error("cannot parse: " + ddl);
    const props = { name: m[1], engine: m[2], orderBy: m[3], ddl };
    if (m[4]) props.ttl = m[4];
    if (m[5]) props.comment = m[5];
    const entity = new Table(props);
    setInterpolationFields(entity, fields);
    return entity;
  }
`;

const TAG_COMPOSITES = `
  import { table } from "./tags";
  import { Composite } from ${JSON.stringify(compositePath)};

  export const EventsTable = Composite((props) => {
    const rollupName = \`\${props.name}_daily\`;
    const events = table\`CREATE TABLE \${props.name} ENGINE = MergeTree ORDER BY ts TTL ts + INTERVAL \${props.ttlDays} DAY\`;
    const rollup = table\`CREATE TABLE \${rollupName} ENGINE = \${"SummingMergeTree"} ORDER BY ts COMMENT \${events}\`;
    return { events, rollup };
  }, "EventsTable");
`;

const TAG_MAIN = `
  import { table } from "../tags";
  import { EventsTable } from "../composites";

  export const audit = table\`CREATE TABLE audit ENGINE = MergeTree ORDER BY ts\`;
  export const clicks = EventsTable({ name: "clicks", ttlDays: 30 });
`;

describe("fold provenance through a tagged template in a composite factory (#3212)", () => {
  let testDir: string;
  let srcDir: string;

  beforeEach(async () => {
    const dir = join(repoRoot, ".cache", `chant-3212-${process.pid}-${seq++}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    testDir = await realpath(dir);
    srcDir = join(testDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(testDir, "tags.ts"), TAGS);
    await writeFile(join(testDir, "composites.ts"), TAG_COMPOSITES);
    await writeFile(join(srcDir, "main.ts"), TAG_MAIN);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const buildIt = () =>
    build(srcDir, [namesSerializer], undefined, {
      fold: true,
      lexicons: [LEXICON_NAME],
      intrinsics: [{ name: "table", isTag: true }],
    });

  test("a field fed by ${props.x} is that parameter, a field the text fixes is a literal", async () => {
    const result = await buildIt();
    expect(result.errors).toEqual([]);
    const events = result.foldProvenance.clicksEvents;
    const rollup = result.foldProvenance.clicksRollup;
    const at = (parameters: string[]) => ({ kind: "composite-parameter", composite: "EventsTable", instance: "clicks", parameters });
    const fixed = { kind: "composite-literal", composite: "EventsTable", instance: "clicks" };

    expect(events.fields.name).toMatchObject(at(["name"]));
    expect(events.fields.ttl).toMatchObject(at(["ttlDays"]));
    expect(events.fields.ddl).toMatchObject(at(["name", "ttlDays"]));
    expect(events.fields.engine).toMatchObject(fixed);
    expect(events.fields.orderBy).toMatchObject(fixed);
    // #3597 — the argument behind a tag-fed field, where the call wrote it.
    expect(events.fields.ttl).toMatchObject({ arguments: [{ parameter: "ttlDays", line: 6, text: "ttlDays: 30" }] });
    expect(events.fields.ddl).toMatchObject({
      arguments: [{ parameter: "name", text: 'name: "clicks"' }, { parameter: "ttlDays", text: "ttlDays: 30" }],
    });

    // Through a body `const`; an interpolated literal string is fixed; an
    // interpolated sibling entity is wiring, so it governs nothing.
    expect(rollup.fields.name).toMatchObject(at(["name"]));
    expect(rollup.fields.engine).toMatchObject(fixed);
    expect(rollup.fields.comment).toMatchObject(fixed);
    expect(rollup.fields.ddl).toMatchObject(at(["name"]));

    expect(result.foldProvenance.audit.fields.ttl).toBeUndefined();
    expect(result.foldProvenance.audit.fields.name).toEqual({ kind: "direct" });
  });

  test("drift on a parameter-fed field proposes the parameter at the call site", async () => {
    const result = await buildIt();
    const provenanceOf = (name: string): EntityProvenance | undefined => {
      const entity = result.entities.get(name);
      return entity ? getProvenance(entity) : undefined;
    };
    const drift = (name: string, path: string, declared: unknown, live: unknown): DeepEntityDrift => {
      const origin = originOfPath(provenanceOf(name)?.paths, path);
      return { name, type: "Test::Table", changes: [{ path, kind: "changed", declared, live, ...(origin ? { origin } : {}) }] };
    };

    const [ttl, engine] = resolveDeepDrift(
      [
        drift("clicksEvents", "ttl", "ts + INTERVAL 30 DAY", "ts + INTERVAL 90 DAY"),
        drift("clicksEvents", "engine", "MergeTree", "ReplacingMergeTree"),
      ],
      provenanceOf,
    );

    expect(ttl.resolution.kind).toBe("propose-parameter");
    if (ttl.resolution.kind !== "propose-parameter") throw new Error("unreachable");
    expect(ttl.resolution.parameters).toEqual(["ttlDays"]);
    expect(ttl.resolution.instance).toBe("clicks");
    expect(ttl.resolution.sourceFile).toContain("main.ts");
    expect(engine.resolution.kind).toBe("refuse-fixed");
  });
});
