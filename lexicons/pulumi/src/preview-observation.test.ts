/**
 * The preview depth of `describeResources` (#5332): `CHANT_PULUMI_OBSERVE=preview`
 * against a fake engine binary, a node script written per test that answers
 * `preview --json` from a mode file beside it. No pulumi or plunge runs.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildLiveGraphIr } from "@intentius/chant/graph-ir";
import { normalizeObservation } from "@intentius/chant/observation";
import { describePulumiResources } from "./describe-resources";
import { PULUMI_BLINDED_SECRET, PULUMI_UNKNOWN } from "./values";
import { KNOWN_AFTER_APPLY, observePreview, PREVIEW_READ_REASONS, previewReadReason, type PreviewReadReason } from "./preview-observation";
import { engineRunnerAt, type PulumiRunner } from "./run";

const testdata = join(import.meta.dirname, "testdata");
const unexported = join(testdata, "pulumi-unexported");
const memberDir = join(testdata, "pulumi-member");
const createDoc = readFileSync(join(testdata, "pulumi-preview", "preview-create.json"), "utf-8");

const FAKE = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const mode = JSON.parse(fs.readFileSync(path.join(__dirname, "mode.json"), "utf-8"));
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify(process.argv.slice(2)) + "\\n");
if (mode.stderr) { process.stderr.write(mode.stderr + "\\n"); process.exit(255); }
process.stdout.write(mode.stdout);
`;

/** A fake engine binary: its runner, and the argv it saw. */
function fakeBinary(mode: { stdout?: string; stderr?: string }): { run: PulumiRunner; calls: () => string[][]; setMode: (m: { stdout?: string; stderr?: string }) => void } {
  const dir = mkdtempSync(join(tmpdir(), "chant-pulumi-preview-5332-"));
  const bin = join(dir, "engine");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  const setMode = (m: { stdout?: string; stderr?: string }) => writeFileSync(join(dir, "mode.json"), JSON.stringify(m));
  setMode(mode);
  writeFileSync(join(dir, "calls.log"), "");
  return {
    run: engineRunnerAt(bin),
    calls: () => readFileSync(join(dir, "calls.log"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]),
    setMode,
  };
}

const ENV = { CHANT_PULUMI_OBSERVE: "preview" };
const urnOf = (type: string, name: string) => `urn:pulumi:dev::app::${type}::${name}`;

function step(op: string, type: string, name: string, extra: Record<string, unknown> = {}) {
  const urn = urnOf(type, name);
  const { oldInputs, newInputs, ...rest } = extra as { oldInputs?: unknown; newInputs?: unknown };
  return {
    op,
    urn,
    ...(op !== "create" ? { oldState: { urn, type, id: `${name}-id`, custom: true, inputs: oldInputs ?? {}, outputs: {} } } : {}),
    ...(op !== "delete" ? { newState: { urn, type, custom: true, inputs: newInputs ?? {}, outputs: {} } } : {}),
    ...rest,
  };
}

describe("a stack with no export (#5332)", () => {
  test("gets its nodes from the preview, marked planned, and runs only preview", async () => {
    const fake = fakeBinary({ stdout: createDoc });
    const result = await describePulumiResources({ entities: new Map() }, { member: { dir: unexported, label: "app" }, run: fake.run, exportStore: null, env: ENV });
    expect(fake.calls()).toEqual([["preview", "--json", "--show-sames"]]);
    const obs = normalizeObservation(result);
    const key = "app/aws:s3/bucket:Bucket::site-bucket";
    expect(obs.resources[key]).toMatchObject({ type: "aws:s3/bucket:Bucket", status: "planned", ownership: "unknown" });
    const attrs = obs.resources[key]!.attributes!;
    expect(attrs.planAction).toBe("create");
    expect(Object.values(attrs.planActions as Record<string, string[]>)).toEqual([["create"]]);
    expect(obs.sources[key]).toBe("preview");
    // The stack and the provider have no node.
    expect(Object.keys(obs.resources).some((k) => k.includes("pulumi:pulumi:Stack") || k.includes("pulumi:providers"))).toBe(false);
    expect(Object.keys(obs.resources).length).toBeGreaterThan(10);
    expect(obs.rootReads).toEqual({ "pulumi.members.app": { depth: "preview" } });
    expect(obs.unobserved).toEqual({});
  });

  test("the live graph holds those nodes with their plan attributes", async () => {
    const fake = fakeBinary({ stdout: createDoc });
    const { resources, rootReads } = normalizeObservation(await describePulumiResources({ entities: new Map() }, { member: { dir: unexported, label: "app" }, run: fake.run, exportStore: null, env: ENV }));
    const ir = buildLiveGraphIr([{ lexicon: "pulumi", resources }]);
    const node = ir.nodes.find((n) => n.id === "app/aws:sqs/queue:Queue::events")!;
    expect(node.attrs.planAction).toBe("create");
    expect(rootReads).toBeDefined();
  });
});

describe("a stack with an export", () => {
  const entities = new Map([
    ["app/aws:iam/role:Role::web", { entityType: "aws:iam/role:Role", props: {} }],
    ["app/aws:s3/bucket:Bucket::assets", { entityType: "aws:s3/bucket:Bucket", props: {} }],
    ["app/my:mod:Web::web-app", { entityType: "my:mod:Web", props: {} }],
  ]);
  const doc = JSON.stringify({
    steps: [
      step("update", "aws:iam/role:Role", "web", { oldInputs: { description: "a" }, newInputs: { description: "b" }, detailedDiff: { description: { kind: "update" } } }),
      step("replace", "aws:s3/bucket:Bucket", "assets", {
        oldInputs: { bucket: "one" },
        newInputs: { bucket: "two" },
        replaceReasons: ["bucket"],
        detailedDiff: { bucket: { kind: "update-replace" } },
      }),
      step("create", "aws:sqs/queue:Queue", "jobs", { newInputs: { name: PULUMI_UNKNOWN, delaySeconds: 5 } }),
    ],
  });

  test("marks declared nodes with the operation and the changed leaves, and adds the created one as planned", async () => {
    const fake = fakeBinary({ stdout: doc });
    const obs = normalizeObservation(await describePulumiResources({ entities }, { member: { dir: memberDir, label: "app" }, run: fake.run, exportStore: null, env: ENV }));
    expect(fake.calls()[0]).toEqual(["preview", "--json", "--show-sames", "--stack", "dev"]);
    expect(obs.resources["app/aws:iam/role:Role::web"]).toMatchObject({ status: "recorded", attributes: { planAction: "update", planChanges: [{ path: "description", before: "a", after: "b" }] } });
    expect(obs.resources["app/aws:s3/bucket:Bucket::assets"]!.attributes).toMatchObject({ planAction: "replace", planReplacePaths: ["bucket"], planChanges: [{ path: "bucket", before: "one", after: "two" }] });
    const queue = obs.resources["app/aws:sqs/queue:Queue::jobs"]!;
    expect(queue.status).toBe("planned");
    expect(queue.attributes).toMatchObject({ planAction: "create", planAfterUnknown: ["name"], delaySeconds: 5 });
    // A declared node the preview lists no step for is not observed, not absent.
    expect(obs.unobserved["app/my:mod:Web::web-app"]).toMatchObject({ reason: "not-reached", type: "my:mod:Web" });
  });

  test("a delete-first replace says so", () => {
    const urn = urnOf("aws:ec2/vpc:Vpc", "main");
    const steps = [
      { op: "delete-replaced", urn, oldState: { urn, type: "aws:ec2/vpc:Vpc", id: "v", inputs: {}, outputs: {} } },
      { op: "create-replacement", urn, newState: { urn, type: "aws:ec2/vpc:Vpc", inputs: {}, outputs: {} } },
    ];
    const seen = observePreview({ label: "app", preview: { steps }, declared: new Map() })!;
    expect(seen.resources["app/aws:ec2/vpc:Vpc::main"]!.attributes).toMatchObject({ planAction: "replace", planActionReason: "delete-before-replace" });
  });
});

describe("what a preview adds to a node is filtered like an export's inputs", () => {
  const secretValue = "hunter2-do-not-leak";
  const doc = {
    steps: [
      step("update", "aws:rds/instance:Instance", "db", {
        oldInputs: { password: "old-pw-do-not-leak", engine: "pg", settings: { apiKey: "key-old-do-not-leak", size: 1 }, masterUser: { [PULUMI_BLINDED_SECRET]: 1 }, tags: { a: "x" }, note: "n".repeat(2000), kmsSecretArn: "arn:old" },
        newInputs: { password: secretValue, engine: "mysql", settings: { apiKey: "key-new-do-not-leak", size: 2 }, masterUser: PULUMI_BLINDED_SECRET, tags: { a: "y" }, note: "m".repeat(2000), kmsSecretArn: "arn:new" },
        detailedDiff: { password: { kind: "update" }, engine: { kind: "update-replace" }, "settings.apiKey": { kind: "update" }, "settings.size": { kind: "update" }, masterUser: { kind: "update" }, "tags.a": { kind: "update" }, note: { kind: "update" }, kmsSecretArn: { kind: "update" } },
        replaceReasons: ["engine", "password"],
      }),
      step("create", "kubernetes:core/v1:Secret", "creds", { newInputs: { metadata: { name: "creds" }, data: { token: "dG9rZW4=" }, stringData: { a: "plain-secret-value" } } }),
      step("update", "kubernetes:core/v1:ConfigMap", "cfg", {
        oldInputs: { data: { k: "old-cm-value" }, metadata: { name: "cfg" } },
        newInputs: { data: { k: "new-cm-value" }, metadata: { name: "cfg" } },
        detailedDiff: { "data.k": { kind: "update" } },
      }),
    ],
  };

  test("secrets, credential-like keys, Secret and ConfigMap data and long strings are left out", () => {
    const seen = observePreview({ label: "app", preview: doc, declared: new Map() })!;
    const text = JSON.stringify(seen);
    for (const leak of [secretValue, "old-pw", "key-old", "key-new", "dG9rZW4", "plain-secret-value", "old-cm-value", "new-cm-value", "nnnnnnnn", "mmmmmmmm"]) expect(text).not.toContain(leak);
    const db = seen.resources["app/aws:rds/instance:Instance::db"]!.attributes!;
    expect(db.planChanges).toEqual([
      { path: "engine", before: "pg", after: "mysql" },
      { path: "kmsSecretArn", before: "arn:old", after: "arn:new" },
      { path: "settings.size", before: 1, after: 2 },
      { path: "tags.a", before: "x", after: "y" },
    ]);
    expect(db.planReplacePaths).toEqual(["engine"]);
    const cfg = seen.resources["app/kubernetes:core/v1:ConfigMap::cfg"]!.attributes!;
    expect(cfg.planAction).toBe("update");
    expect(cfg.planChanges).toBeUndefined();
    const secret = seen.resources["app/kubernetes:core/v1:Secret::creds"]!.attributes!;
    expect(secret).not.toHaveProperty("data");
    expect(secret).not.toHaveProperty("stringData");
    expect(secret).toMatchObject({ metadata: { name: "creds" } });
  });

  test("an unknown after value reads (known after apply)", () => {
    const d = { steps: [step("update", "aws:s3/bucket:Bucket", "b", { oldInputs: { bucket: "x" }, newInputs: { bucket: PULUMI_UNKNOWN }, detailedDiff: { bucket: { kind: "update" } } })] };
    const seen = observePreview({ label: "app", preview: d, declared: new Map() })!;
    expect(seen.resources["app/aws:s3/bucket:Bucket::b"]!.attributes).toMatchObject({ planChanges: [{ path: "bucket", before: "x", after: KNOWN_AFTER_APPLY }], planAfterUnknown: ["bucket"] });
  });
});

describe("when the preview did not answer", () => {
  const cases: Array<[PreviewReadReason, string]> = [
    ["no-credentials", "error: no valid credential sources for AWS were found"],
    ["needs-install", "error: Cannot find module '@pulumi/aws'. Run `pulumi install` to install dependencies"],
    ["no-stack", "error: no stack selected; specify a stack with --stack"],
    ["preview-failed", "error: program exited with code 1"],
  ];
  for (const [reason, stderr] of cases) {
    test(`${reason}: the member falls back to declared only and rootReads says why`, async () => {
      const fake = fakeBinary({ stderr });
      const entities = new Map([["app/aws:s3/bucket:Bucket::assets", { entityType: "aws:s3/bucket:Bucket", props: {} }]]);
      const obs = normalizeObservation(await describePulumiResources({ entities }, { member: { dir: memberDir, label: "app" }, run: fake.run, exportStore: null, env: ENV }));
      expect(obs.rootReads).toEqual({ "pulumi.members.app": { depth: "preview", fellBackTo: "declared", reason } });
      expect(obs.resources).toEqual({});
      expect(obs.unobserved["app/aws:s3/bucket:Bucket::assets"]).toMatchObject({ reason: "no-binding" });
      expect(obs.notes.join("\n")).toContain(reason);
    });
  }

  test("a missing binary is no-binary, and a document with no steps is a failed preview", async () => {
    expect(previewReadReason("the pulumi binary was not found on PATH; install pulumi to plan this member")).toBe("no-binary");
    const fake = fakeBinary({ stdout: "not json" });
    const obs = normalizeObservation(await describePulumiResources({ entities: new Map() }, { member: { dir: unexported, label: "app" }, run: fake.run, exportStore: null, env: ENV }));
    expect(obs.rootReads!["pulumi.members.app"]).toMatchObject({ depth: "preview", fellBackTo: "declared", reason: "preview-failed" });
  });

  test("a member on plunge falls back to plunge's records", async () => {
    const graph = readFileSync(join(import.meta.dirname, "..", "..", "..", "packages", "core", "src", "graph-schema", "fixtures", "plunge.engine-graph.json"), "utf-8");
    const calls: string[][] = [];
    const plunge: PulumiRunner = async (args) => {
      calls.push(args);
      if (args[0] === "preview") throw Object.assign(new Error("plunge preview failed"), { stderr: "error: no valid credential sources" });
      return { stdout: graph };
    };
    const dir = join(testdata, "plunge-graph");
    const obs = normalizeObservation(await describePulumiResources({ entities: new Map() }, { member: { dir, label: "app", engine: "plunge" }, plunge, exportStore: null, env: ENV }));
    expect(calls.map((c) => c[0])).toEqual(["preview", "graph"]);
    expect(obs.rootReads!["pulumi.members.app"]).toEqual({ depth: "preview", fellBackTo: "state", reason: "no-credentials" });
    expect(Object.keys(obs.resources).length).toBeGreaterThan(0);
  });

  test("a member on plunge previews with plunge preview", async () => {
    const calls: string[][] = [];
    const plunge: PulumiRunner = async (args) => {
      calls.push(args);
      return { stdout: createDoc };
    };
    const obs = normalizeObservation(await describePulumiResources({ entities: new Map() }, { member: { dir: unexported, label: "app", engine: "plunge" }, plunge, exportStore: null, env: ENV }));
    expect(calls).toEqual([["preview", "--json", "--show-sames"]]);
    expect(obs.rootReads).toEqual({ "pulumi.members.app": { depth: "preview" } });
  });
});

describe("the depth", () => {
  test("is state unless asked: nothing runs", async () => {
    const fake = fakeBinary({ stdout: createDoc });
    const entities = new Map([["app/aws:s3/bucket:Bucket::assets", { entityType: "aws:s3/bucket:Bucket", props: {} }]]);
    const obs = normalizeObservation(await describePulumiResources({ entities }, { member: { dir: memberDir, label: "app" }, run: fake.run, exportStore: null, env: {} }));
    expect(fake.calls()).toEqual([]);
    expect(obs.unobserved["app/aws:s3/bucket:Bucket::assets"]!.reason).toBe("no-binding");
    expect(obs.rootReads).toBeUndefined();
  });

  test("a value that is neither state nor preview is ignored with a note", async () => {
    const obs = normalizeObservation(await describePulumiResources({ entities: new Map() }, { member: { dir: memberDir, label: "app" }, env: { CHANT_PULUMI_OBSERVE: "plan" } }));
    expect(obs.notes.join("\n")).toContain('CHANT_PULUMI_OBSERVE="plan" is neither "state" nor "preview"');
  });

  test("the caller's depth beats the variable", async () => {
    const fake = fakeBinary({ stdout: createDoc });
    await describePulumiResources({ entities: new Map(), depth: "state" }, { member: { dir: unexported, label: "app" }, run: fake.run, exportStore: null, env: ENV });
    expect(fake.calls()).toEqual([]);
  });
});

describe("the docs", () => {
  const docs = readFileSync(join(import.meta.dirname, "..", "docs", "pages", "member.mdx"), "utf-8");
  test("list each read reason", () => {
    for (const reason of Object.keys(PREVIEW_READ_REASONS)) expect(docs, reason).toContain(`\`${reason}\``);
  });
  test("name the variable", () => {
    expect(docs).toContain("CHANT_PULUMI_OBSERVE=preview");
  });
});
