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
    expect(classifyFieldOrigin({ kind: "composite-literal", composite: "WebService" }, composite)).toEqual({
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
  import { WebService, LegacyService } from "../composites";

  export const logs = new Bucket({ BucketName: "logs" });
  export const web = WebService({ name: "data", tier: "prod", iam: { path: "/service/" } });
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
    expect(result.foldProvenance.webBucket.fields.BucketName).toEqual({
      kind: "composite-parameter",
      composite: "WebService",
      instance: "web",
      parameters: ["name"],
    });
    expect(result.foldProvenance.webBucket.fields.Tags).toEqual({
      kind: "composite-parameter",
      composite: "WebService",
      instance: "web",
      parameters: ["tier"],
    });
    expect(result.foldProvenance.webRole.fields.RoleName).toEqual({
      kind: "composite-parameter",
      composite: "WebService",
      instance: "web",
      parameters: ["name"],
    });
    expect(result.foldProvenance.webRole.fields.Path).toEqual({
      kind: "composite-parameter",
      composite: "WebService",
      instance: "web",
      parameters: ["iam.path"],
    });

    // 2. A field the composite FIXES.
    expect(result.foldProvenance.webBucket.fields["VersioningConfiguration.Status"]).toEqual({
      kind: "composite-literal",
      composite: "WebService",
      instance: "web",
    });
    expect(result.foldProvenance.webRole.fields.Description).toEqual({
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
});
