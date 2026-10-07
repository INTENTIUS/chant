/**
 * chant#3598 — `foldProject` reports fold provenance, and agrees with `build()`.
 *
 * The specification's conformance adapter calls `foldProject`, not `build()`,
 * so the four origin kinds (spec 2.2) have to be readable there. The tests
 * compare against `build()` over the same files rather than restating the
 * expected origins, because "the same shape build() uses" means the same
 * answers too.
 *
 * The sandbox half pins the one rule that matters most: an entity whose
 * provenance record did not survive is `unknown`, never `direct`.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../build";
import { foldProject, getProvenance, foldProvenanceOfEntities, type FoldProvenance } from "../index";
import { decodeEntitySet, encodeEntitySet } from "./entity-wire-codec";
import type { Serializer } from "../serializer";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "../../../..");
const compositePath = resolve(thisDir, "../composite");

const LEXICON = "@intentius/chant-lexicon-aws";
const LEXICON_NAME = "aws";

const namesSerializer: Serializer = {
  name: LEXICON_NAME,
  rulePrefix: "TEST",
  serialize: (entities) => JSON.stringify({ resources: [...entities.keys()].sort() }, null, 2),
};

/**
 * `WebService` is inside the admissible subset, so its body is interpreted:
 * `BucketName` flows from a parameter and `VersioningConfiguration.Status` is
 * a literal the body sets. `LegacyService` has an `if`, so it is invoked
 * rather than interpreted and its fields are unknown.
 */
const COMPOSITES = `
  import { Bucket } from ${JSON.stringify(LEXICON)};
  import { Composite } from ${JSON.stringify(compositePath)};

  export const WebService = Composite((props) => {
    const bucket = new Bucket({
      BucketName: props.name,
      VersioningConfiguration: { Status: "Enabled" },
    });
    return { bucket };
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
  export const web = WebService({ name: "data" });
`;

const LEGACY_MAIN = `
  import { LegacyService } from "../composites";

  export const legacy = LegacyService({ name: "old" });
`;

/** Every field of every composite-expanded entity, with its origin kind. */
function compositeFieldKinds(provenance: FoldProvenance): string[] {
  const out: string[] = [];
  for (const [name, record] of Object.entries(provenance)) {
    if (!record.composite) continue;
    for (const [path, origin] of Object.entries(record.fields)) out.push(`${name}.${path}:${origin.kind}`);
  }
  return out.sort();
}

describe("foldProject reports fold provenance (chant#3598)", () => {
  let testDir: string;
  let srcDir: string;
  let mainFile: string;
  let legacyFile: string;

  beforeAll(async () => {
    // Inside the repo, so the fixture's import of the real lexicon resolves.
    const dir = join(repoRoot, ".cache", `chant-3598-${process.pid}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    testDir = await realpath(dir);
    srcDir = join(testDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(testDir, "composites.ts"), COMPOSITES);
    mainFile = join(srcDir, "main.ts");
    legacyFile = join(srcDir, "legacy.ts");
    await writeFile(mainFile, MAIN);
    await writeFile(legacyFile, LEGACY_MAIN);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("parameter, literal and direct origins match what build() reports", async () => {
    const verdicts = await foldProject([legacyFile, mainFile], [], { lexicons: [LEXICON_NAME] });
    const main = verdicts.get(mainFile)!;
    expect(main.verdict).toBe("fold");

    const fromFold = main.foldProvenance!;
    expect(Object.keys(fromFold).sort()).toEqual(["logs", "webBucket"]);
    expect(fromFold.webBucket.fields.BucketName).toEqual({
      kind: "composite-parameter",
      composite: "WebService",
      instance: "web",
      parameters: ["name"],
    });
    expect(fromFold.webBucket.fields["VersioningConfiguration.Status"]).toEqual({
      kind: "composite-literal",
      composite: "WebService",
      instance: "web",
    });
    expect(fromFold.logs.fields.BucketName).toEqual({ kind: "direct" });
    expect(fromFold.webBucket.sourceFile).toBe(mainFile);

    const built = await build(srcDir, [namesSerializer], undefined, { fold: true, lexicons: [LEXICON_NAME] });
    expect(built.errors).toEqual([]);
    expect(fromFold.webBucket).toEqual(built.foldProvenance.webBucket);
    expect(fromFold.logs).toEqual(built.foldProvenance.logs);

    // The legacy file runs, so foldProject has no entities to attribute there.
    const legacy = verdicts.get(legacyFile)!;
    expect(legacy.verdict).toBe("run");
    expect(legacy.foldProvenance).toBeUndefined();
  });

  test("a composite invoked rather than interpreted is unknown, as build() says", async () => {
    const verdicts = await foldProject([legacyFile, mainFile], [], { lexicons: [LEXICON_NAME], executing: true });
    const legacy = verdicts.get(legacyFile)!;
    expect(legacy.verdict).toBe("fold");
    const record = legacy.foldProvenance!.legacyBucket;
    expect(record.composite).toBe("LegacyService");
    expect(record.fields.BucketName).toEqual({ kind: "unknown", reason: "composite-not-interpreted" });
    expect(record.fields.ObjectLockEnabled).toEqual({ kind: "unknown", reason: "composite-not-interpreted" });

    const built = await build(srcDir, [namesSerializer], undefined, {
      fold: true,
      executing: true,
      lexicons: [LEXICON_NAME],
    });
    expect(built.errors).toEqual([]);
    expect(record).toEqual(built.foldProvenance.legacyBucket);
    expect(verdicts.get(mainFile)!.foldProvenance).toEqual({
      logs: built.foldProvenance.logs,
      webBucket: built.foldProvenance.webBucket,
    });
  });

  test("under sandbox, no composite-expanded field is ever reported direct", async () => {
    const verdicts = await foldProject([legacyFile, mainFile], [], { lexicons: [LEXICON_NAME], sandbox: true });
    const reported = [...verdicts.values()].flatMap((v) => (v.foldProvenance ? compositeFieldKinds(v.foldProvenance) : []));
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.filter((entry) => entry.endsWith(":direct"))).toEqual([]);

    // The sandboxed build: `legacy.ts` runs in the child, and its entities
    // come back over the wire without a provenance record.
    const built = await build(srcDir, [namesSerializer], undefined, {
      fold: true,
      sandbox: true,
      lexicons: [LEXICON_NAME],
    });
    expect(built.errors).toEqual([]);
    const legacyBucket = built.foldProvenance.legacyBucket;
    expect(legacyBucket).toBeDefined();
    expect(Object.values(legacyBucket.fields).length).toBeGreaterThan(0);
    for (const origin of Object.values(legacyBucket.fields)) {
      expect(origin).toEqual({ kind: "unknown", reason: "no-provenance" });
    }
  });

  test("an entity set that crossed the wire reports unknown for every field, never direct", async () => {
    const built = await build(srcDir, [namesSerializer], undefined, { fold: true, lexicons: [LEXICON_NAME] });
    expect(built.foldProvenance.webBucket.fields.BucketName.kind).toBe("composite-parameter");

    const decoded = decodeEntitySet(encodeEntitySet(built.entities));
    const afterWire = foldProvenanceOfEntities(decoded, getProvenance);
    expect(Object.keys(afterWire).sort()).toEqual(Object.keys(built.foldProvenance).sort());
    for (const record of Object.values(afterWire)) {
      expect(record.composite).toBeUndefined();
      for (const origin of Object.values(record.fields)) {
        expect(origin).toEqual({ kind: "unknown", reason: "no-provenance" });
      }
    }
  });
});
