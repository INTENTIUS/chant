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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
    // chant#3597 — the per-file record carries where the call and its
    // arguments were written, as build()'s does.
    const lines = MAIN.split("\n");
    const webLine = lines.findIndex((l) => l.includes("WebService({")) + 1;
    const columnOf = (needle: string) => lines[webLine - 1].indexOf(needle) + 1;
    const call = { file: mainFile, line: webLine, column: columnOf("WebService({") };
    expect(fromFold.webBucket.compositeCall).toEqual(call);
    expect(fromFold.webBucket.fields.BucketName).toEqual({
      kind: "composite-parameter",
      composite: "WebService",
      instance: "web",
      parameters: ["name"],
      call,
      arguments: [{ parameter: "name", file: mainFile, line: webLine, column: columnOf('name: "data"'), text: 'name: "data"' }],
    });
    expect(fromFold.webBucket.fields["VersioningConfiguration.Status"]).toEqual({
      kind: "composite-literal",
      composite: "WebService",
      instance: "web",
      call,
    });
    expect(fromFold.logs.compositeCall).toBeUndefined();
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

/**
 * A host's composite registration form (chant#2442) returns the factory's own
 * members object rather than a chant `CompositeInstance`. Exported whole, its
 * members still have to be attributed: before this, they had no record at all
 * while a destructured member did.
 */
describe("foldProject attributes a host composite instance exported whole (chant#3598)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "chant-3598-host-"));
    const pkg = join(root, "node_modules", "@tsad", "shapes");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@tsad/shapes", version: "0.0.0", type: "module", main: "index.js" }),
    );
    writeFileSync(
      join(pkg, "index.js"),
      [
        "const MARK = Symbol.for('tsad.conformance.declarable');",
        "export class Bucket {",
        "  constructor(props = {}) {",
        "    this.entityType = 'Bucket'; this.lexicon = 'shapes'; this.props = props;",
        "    Object.defineProperty(this, MARK, { value: true, enumerable: false });",
        "  }",
        "}",
        "export function Composite(factory, name) {",
        "  const d = (props) => factory(props); d.compositeName = name; return d;",
        "}",
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(root, "shapes.ts"),
      'import { Bucket, Composite } from "@tsad/shapes";\n' +
        'export const Store = Composite(({ name }) => ({ logs: new Bucket({ name, tier: "cold" }) }), "Store");\n',
    );
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a whole instance's members have records, as a destructured member does, and none is direct", async () => {
    const file = join(root, "app.ts");
    writeFileSync(
      file,
      'import { Store } from "./shapes";\n' +
        'export const store = Store({ name: "a" });\n' +
        'export const { logs } = Store({ name: "b" });\n',
    );

    const verdict = (await foldProject([file], [], { lexiconPackages: ["@tsad/shapes"], sandbox: true })).get(file)!;
    expect(verdict.reason).toBeUndefined();
    expect(verdict.verdict).toBe("fold");
    const provenance = verdict.foldProvenance!;
    expect(Object.keys(provenance).sort()).toEqual(["logs", "storeLogs"]);

    // chant#3597 — where each call and its argument were written.
    const at = (line: number, source: string, needle: string) => ({ file, line, column: source.indexOf(needle) + 1 });
    const storeLine = 'export const store = Store({ name: "a" });';
    const logsLine = 'export const { logs } = Store({ name: "b" });';
    const storeCall = at(2, storeLine, "Store({");
    expect(provenance.storeLogs).toEqual({
      sourceFile: file,
      composite: "Store",
      instance: "store",
      compositeCall: storeCall,
      fields: {
        name: {
          kind: "composite-parameter",
          composite: "Store",
          instance: "store",
          parameters: ["name"],
          call: storeCall,
          arguments: [{ parameter: "name", ...at(2, storeLine, 'name: "a"'), text: 'name: "a"' }],
        },
        tier: { kind: "composite-literal", composite: "Store", instance: "store", call: storeCall },
      },
    });

    // The destructured member keeps the answer it had, with its own call's locations.
    const logsCall = at(3, logsLine, "Store({");
    expect(provenance.logs.compositeCall).toEqual(logsCall);
    expect(provenance.logs.fields.name).toEqual({
      kind: "composite-parameter",
      composite: "Store",
      parameters: ["name"],
      call: logsCall,
      arguments: [{ parameter: "name", ...at(3, logsLine, 'name: "b"'), text: 'name: "b"' }],
    });

    for (const origin of Object.values(provenance.storeLogs.fields)) expect(origin.kind).not.toBe("direct");

    // The exports handed back are untouched: the instance is still the members object.
    expect(JSON.parse(JSON.stringify(verdict.exports!.get("store")))).toEqual({
      logs: { entityType: "Bucket", lexicon: "shapes", props: { name: "a", tier: "cold" } },
    });
  });
});

/**
 * chant#3608 — the two cases the specification's F-Obs-Provenance fixtures
 * found, against a host shaped like the conformance suite's `shapes` host: its
 * registration form returns a `CompositeInstance` carrying the members, and it
 * publishes a composite of its own (`Archive`) that a fold invokes rather than
 * interprets.
 */
describe("foldProject provenance for host composites (chant#3608)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "chant-3608-host-"));
    const pkg = join(root, "node_modules", "@tsad", "shapes-3608");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@tsad/shapes-3608", version: "0.0.0", type: "module", main: "index.js" }),
    );
    writeFileSync(
      join(pkg, "index.js"),
      [
        "const MARK = Symbol.for('tsad.conformance.declarable');",
        "const COMPOSITE = Symbol.for('tsad.conformance.composite');",
        "export class Bucket {",
        "  constructor(props = {}, attributes = {}) {",
        "    this.entityType = 'Bucket'; this.lexicon = 'shapes'; this.props = props; this.attributes = attributes;",
        "    Object.defineProperty(this, MARK, { value: true, enumerable: false });",
        "  }",
        "}",
        "class CompositeInstance { constructor() { this[COMPOSITE] = true; } }",
        "export const Composite = (factory, name = 'anonymous') => {",
        "  const definition = (props) => Object.assign(new CompositeInstance(), factory(props));",
        "  return Object.assign(definition, { compositeName: name });",
        "};",
        "export const Archive = Composite((props) => ({ bucket: new Bucket({ name: props.name, versioned: true }) }), 'Archive');",
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(root, "inner.ts"),
      'import { Bucket, Composite } from "@tsad/shapes-3608";\n' +
        "export const Inner = Composite((props: { name: string }) => ({\n" +
        '  bucket: new Bucket({ name: props.name, tier: "inner" }),\n' +
        '}), "Inner");\n',
    );
    writeFileSync(
      join(root, "outer.ts"),
      'import { Bucket, Composite } from "@tsad/shapes-3608";\n' +
        'import { Inner } from "./inner";\n' +
        "export const Outer = Composite((props: { name: string }) => ({\n" +
        "  main: Inner({ name: props.name }),\n" +
        '  fixed: Inner({ name: "fixed" }),\n' +
        "  side: new Bucket({ name: props.name }),\n" +
        '}), "Outer");\n',
    );
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a host-published composite's members are unknown, whole or destructured, never direct", async () => {
    mkdirSync(join(root, "archive"), { recursive: true });
    const file = join(root, "archive", "app.ts");
    writeFileSync(
      file,
      'import { Archive } from "@tsad/shapes-3608";\n' +
        'export const archive = Archive({ name: "logs" });\n' +
        'export const { bucket } = Archive({ name: "old" });\n',
    );

    const verdict = (await foldProject([file], [], { lexiconPackages: ["@tsad/shapes-3608"], sandbox: true })).get(file)!;
    expect(verdict.reason).toBeUndefined();
    expect(verdict.verdict).toBe("fold");
    const provenance = verdict.foldProvenance!;
    expect(Object.keys(provenance).sort()).toEqual(["archiveBucket", "bucket"]);

    const unknown = { kind: "unknown", reason: "composite-not-interpreted" };
    expect(provenance.archiveBucket).toEqual({
      sourceFile: file,
      composite: "Archive",
      instance: "archive",
      fields: { name: unknown, versioned: unknown },
    });
    expect(provenance.bucket.composite).toBe("Archive");
    expect(provenance.bucket.fields).toEqual({ name: unknown, versioned: unknown });

    // build() does not expand a host instance exported whole, so the
    // destructured member is the one it can be held to.
    const built = await build(join(root, "archive"), [namesSerializer], undefined, { fold: true });
    expect(built.errors).toEqual([]);
    expect(built.foldProvenance.bucket).toEqual(provenance.bucket);
  });

  test("a whole instance's nested composite members have records, and the innermost composite wins", async () => {
    mkdirSync(join(root, "site"), { recursive: true });
    const file = join(root, "site", "app.ts");
    writeFileSync(
      file,
      'import { Outer } from "../outer";\n' +
        'export const site = Outer({ name: "web" });\n' +
        'export const { main, fixed, side } = Outer({ name: "api" });\n',
    );

    const verdict = (await foldProject([file], [], { lexiconPackages: ["@tsad/shapes-3608"], sandbox: true })).get(file)!;
    expect(verdict.reason).toBeUndefined();
    expect(verdict.verdict).toBe("fold");
    const provenance = verdict.foldProvenance!;
    expect(Object.keys(provenance).sort()).toEqual([
      "fixedBucket",
      "mainBucket",
      "side",
      "siteFixedBucket",
      "siteMainBucket",
      "siteSide",
    ]);

    const innerName = (instance?: string) => ({
      kind: "composite-parameter",
      composite: "Inner",
      ...(instance ? { instance } : {}),
      parameters: ["name"],
    });
    const innerTier = (instance?: string) => ({ kind: "composite-literal", composite: "Inner", ...(instance ? { instance } : {}) });

    expect(provenance.siteMainBucket).toMatchObject({
      sourceFile: file,
      composite: "Inner",
      instance: "site",
      fields: { name: innerName("site"), tier: innerTier("site") },
    });
    expect(provenance.siteFixedBucket.fields).toMatchObject({ name: innerName("site"), tier: innerTier("site") });
    expect(provenance.siteSide).toMatchObject({
      sourceFile: file,
      composite: "Outer",
      instance: "site",
      fields: { name: { kind: "composite-parameter", composite: "Outer", instance: "site", parameters: ["name"] } },
    });

    // chant#3597's locations follow the innermost writer too: a nested
    // member's call is the `Inner(...)` call inside Outer's body, and a
    // member Outer built itself points at the `Outer(...)` call in this file.
    expect(provenance.siteMainBucket.fields.name).toMatchObject({ call: { file: join(root, "outer.ts"), line: 4 } });
    expect(provenance.siteFixedBucket.fields.name).toMatchObject({ call: { file: join(root, "outer.ts"), line: 5 } });
    expect(provenance.siteSide.fields.name).toMatchObject({ call: { file, line: 2 } });

    // The destructured form agrees, field for field, apart from the instance:
    // `main` and `fixed` are host instances exported whole in their own right.
    expect(provenance.mainBucket.fields).toMatchObject({ name: innerName("main"), tier: innerTier("main") });
    expect(provenance.fixedBucket.fields).toMatchObject({ name: innerName("fixed"), tier: innerTier("fixed") });
    expect(provenance.side.fields.name).toMatchObject({ kind: "composite-parameter", composite: "Outer", parameters: ["name"] });
  });
});

/**
 * chant#3608 — a member destructured from a chant composite the build CALLS
 * rather than interprets. A lexicon composite is the common case
 * (`export const { namespace, resourceQuota } = NamespaceEnv({...})`, as the
 * ray-kuberay-gke example writes it): nothing in the build says which
 * argument produced which field, so every field is `unknown`, and before this
 * every one of them read as `direct`.
 */
describe("a member destructured from a called chant composite is unknown (chant#3608)", () => {
  const K8S = "@intentius/chant-lexicon-k8s";
  let srcDir: string;
  let file: string;
  let warn: typeof console.warn;

  beforeAll(async () => {
    // NamespaceEnv warns about a quota with no LimitRange defaults; not this test's concern.
    warn = console.warn;
    console.warn = () => {};
    const dir = join(repoRoot, ".cache", `chant-3608-${process.pid}`);
    await rm(dir, { recursive: true, force: true });
    srcDir = join(await (async () => (await mkdir(dir, { recursive: true }), realpath(dir)))(), "src");
    await mkdir(srcDir, { recursive: true });
    file = join(srcDir, "namespace.ts");
    await writeFile(
      file,
      `import { NamespaceEnv } from ${JSON.stringify(K8S)};\n` +
        `import { propagate } from ${JSON.stringify(compositePath)};\n` +
        'export const { namespace, resourceQuota } = NamespaceEnv({ name: "ray-system", cpuQuota: "8" });\n' +
        'export const shared = propagate(NamespaceEnv({ name: "shared", cpuQuota: "4" }), { metadata: { labels: { team: "data" } } });\n',
    );
  });

  afterAll(async () => {
    console.warn = warn;
    await rm(dirname(srcDir), { recursive: true, force: true });
  });

  const unknown = { kind: "unknown", reason: "composite-not-interpreted" };

  /** Every field of every named record is unknown, and the record names the composite. */
  function expectAllUnknown(provenance: FoldProvenance, names: string[]): void {
    for (const name of names) {
      const record = provenance[name];
      expect(record, name).toBeDefined();
      expect(record.composite, name).toBe("NamespaceEnv");
      expect(Object.keys(record.fields).length, name).toBeGreaterThan(0);
      for (const [path, origin] of Object.entries(record.fields)) expect(origin, `${name}.${path}`).toEqual(unknown);
    }
  }

  test.each([{}, { executing: true }, { sandbox: true }])("foldProject and build() agree, %o", async (mode) => {
    const verdict = (await foldProject([file], [], { lexicons: ["k8s"], ...mode })).get(file)!;
    expect(verdict.verdict).toBe("fold");
    const fromFold = verdict.foldProvenance!;
    expectAllUnknown(fromFold, ["namespace", "resourceQuota", "sharedNamespace", "sharedResourceQuota"]);
    // The propagated key, written by the composite and by the shared props, stays unknown.
    expect(fromFold.sharedNamespace.fields["metadata.name"]).toEqual(unknown);

    const built = await build(srcDir, [namesSerializer], undefined, { fold: true, lexicons: ["k8s"], ...mode });
    expect(built.errors).toEqual([]);
    for (const name of ["namespace", "resourceQuota"]) expect(built.foldProvenance[name], name).toEqual(fromFold[name]);
  });

  test("the run path reports them unknown too", async () => {
    const built = await build(srcDir, [namesSerializer], undefined, {});
    expect(built.errors).toEqual([]);
    expectAllUnknown(built.foldProvenance, ["namespace", "resourceQuota", "sharedNamespace", "sharedResourceQuota"]);
  });
});
