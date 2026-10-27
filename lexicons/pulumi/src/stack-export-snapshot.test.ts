/**
 * The stack export as the member's snapshot (#4546): `pulumi-up` writes the
 * export, secrets stripped, through the index store after `up`, and the
 * graph and the member's reads take it before a checked-in
 * `stack-export.json`.
 *
 * The runners are fakes answering with the recorded corpus export
 * (`testdata/pulumi-preview/stack-export.json`), and the store is chant's
 * `local` store in a temp directory, so no git ref is written, no engine
 * runs and nothing reaches a backend.
 */
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { DeployContext } from "@intentius/chant/components/capability";
import { createSnapshotStore, type SnapshotStore } from "@intentius/chant/lifecycle/snapshot-store";
import { createPulumiUpCapability } from "./pulumi-up";
import { memberExportOf, type PulumiRunner } from "./run";
import {
  pulumiExportSnapshotKey,
  pulumiStackExportArgs,
  readMemberExportStored,
  readStoredPulumiExport,
  stripPulumiExportSecrets,
  writePulumiExportSnapshot,
} from "./stack-export-snapshot";
import { PULUMI_SECRET_SIG } from "./values";
import { readPulumiMember } from "./workspace-member";

const testdata = join(import.meta.dirname, "testdata");
const exportText = readFileSync(join(testdata, "pulumi-preview", "stack-export.json"), "utf-8");
const stream = readFileSync(join(testdata, "pulumi-stream", "preview-stream.ndjson"), "utf-8");
const upStream = stream.replaceAll(',"planning":true', "");
const stackOutput = readFileSync(join(testdata, "pulumi-outputs", "stack-output.json"), "utf-8");
const ctx: DeployContext = { env: "prod", component: "site" };

const tmp = (): string => mkdtempSync(join(tmpdir(), "pulumi-export-test-"));
const localStore = (): SnapshotStore => createSnapshotStore({ store: "local", dir: tmp() });

/** A stack directory with Pulumi.yaml and no checked-in export. */
function unexportedStack(): string {
  const dir = tmp();
  cpSync(join(testdata, "pulumi-preview", "Pulumi.yaml"), join(dir, "Pulumi.yaml"));
  return dir;
}

function engine(): { run: PulumiRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: PulumiRunner = async (args) => {
    calls.push(args);
    if (args[0] === "preview") return { stdout: stream };
    if (args[0] === "up") return { stdout: upStream };
    if (args[0] === "stack" && args[1] === "export") return { stdout: exportText };
    return { stdout: stackOutput };
  };
  return { run, calls };
}

describe("stripping secrets", () => {
  test("every secret envelope becomes [secret] and the secrets provider's state is gone", () => {
    const stripped = JSON.stringify(stripPulumiExportSecrets(JSON.parse(exportText)));
    expect(exportText).toContain(PULUMI_SECRET_SIG);
    expect(stripped).not.toContain(PULUMI_SECRET_SIG);
    expect(stripped).not.toContain("ciphertext");
    expect(stripped).not.toContain("salt");
    expect(stripped).toContain('"dbPasswordValue":"[secret]"');
    expect(stripped).toContain('"secrets_providers":{"type":"passphrase"}');
  });

  test("a plaintext envelope is blinded too, and the input is left alone", () => {
    const doc = { deployment: { resources: [{ urn: "u", type: "t", outputs: { p: { "4dabf18193072939515e22adb298388d": PULUMI_SECRET_SIG, plaintext: '"hunter2"' } } }] } };
    const before = JSON.stringify(doc);
    expect(JSON.stringify(stripPulumiExportSecrets(doc))).not.toContain("hunter2");
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("writing and reading the snapshot", () => {
  test("the export runs as stack export --stack <s> and lands at <env>/<stack>__pulumi-export", async () => {
    const dir = unexportedStack();
    const store = localStore();
    const pulumi = engine();
    const wrote = await writePulumiExportSnapshot({ dir, stack: "floci", environment: "prod", engine: "pulumi", run: pulumi.run, store });
    expect(pulumi.calls).toEqual([pulumiStackExportArgs({ stack: "floci" })]);
    expect(pulumi.calls[0]).toEqual(["stack", "export", "--stack", "floci"]);
    expect(wrote).toMatchObject({ written: true, key: `prod/${pulumiExportSnapshotKey("floci")}` });
    const text = await store.readLatest("prod", "floci__pulumi-export", { cwd: dir });
    expect(text).not.toBeNull();
    expect(text).not.toContain(PULUMI_SECRET_SIG);
    const snap = JSON.parse(text!);
    expect(snap).toMatchObject({ lexicon: "pulumi", environment: "prod", stack: "floci", engine: "pulumi" });
    expect(Object.keys(snap.resources).length).toBeGreaterThan(0);
    expect(snap.stackExports.floci.dbPasswordValue).toBeUndefined();
  });

  test("plunge exports with plunge stack export", async () => {
    const dir = unexportedStack();
    const plunge = engine();
    const stock = engine();
    const wrote = await writePulumiExportSnapshot({ dir, stack: "floci", environment: "prod", engine: "plunge", plunge: plunge.run, run: stock.run, store: localStore() });
    expect(wrote.written).toBe(true);
    expect(plunge.calls).toEqual([["stack", "export", "--stack", "floci"]]);
    expect(stock.calls).toEqual([]);
  });

  test("a failed export or a store that keeps nothing never throws", async () => {
    const dir = unexportedStack();
    const failing: PulumiRunner = async () => {
      throw Object.assign(new Error("exit 255"), { code: 255, stderr: "error: no stack named floci" });
    };
    expect(await writePulumiExportSnapshot({ dir, stack: "floci", environment: "prod", engine: "pulumi", run: failing, store: localStore() })).toMatchObject({
      written: false,
      reason: expect.stringMatching(/no stack named floci/),
    });
    const pulumi = engine();
    expect(await writePulumiExportSnapshot({ dir, stack: "floci", environment: "prod", engine: "pulumi", run: pulumi.run, store: createSnapshotStore({ store: "none" }) })).toMatchObject({ written: false });
    expect(await writePulumiExportSnapshot({ dir, stack: "floci", environment: "prod", engine: "pulumi", run: pulumi.run, store: null })).toMatchObject({ written: false });
    expect(pulumi.calls).toEqual([]);
  });

  test("the reads take the store's export, else the checked-in file", async () => {
    const dir = unexportedStack();
    const store = localStore();
    expect(await readMemberExportStored(dir, { store })).toBeUndefined();
    await writePulumiExportSnapshot({ dir, stack: "floci", environment: "prod", engine: "pulumi", run: engine().run, store });
    const read = await readMemberExportStored(dir, { stack: "floci", store });
    expect(read?.source.from).toBe("store");
    expect(JSON.stringify(read?.doc)).not.toContain(PULUMI_SECRET_SIG);
    expect(await memberExportOf(dir, { store })).toEqual(read?.doc);
    expect(await readStoredPulumiExport({ dir, stack: "other", store })).toBeUndefined();

    const checkedIn = join(testdata, "pulumi-preview");
    expect((await readMemberExportStored(checkedIn, { store: localStore() }))?.source).toEqual({ from: "file", file: "stack-export.json" });
    expect(await memberExportOf(checkedIn, { store: null })).toEqual(JSON.parse(exportText));
  });

  test("with no stack named, a store holding two stacks' exports gives none", async () => {
    const dir = unexportedStack();
    const store = localStore();
    await writePulumiExportSnapshot({ dir, stack: "floci", environment: "prod", engine: "pulumi", run: engine().run, store });
    await writePulumiExportSnapshot({ dir, stack: "staging", environment: "prod", engine: "pulumi", run: engine().run, store });
    expect(await readStoredPulumiExport({ dir, store })).toBeUndefined();
    expect((await readStoredPulumiExport({ dir, stack: "staging", store }))?.stack).toBe("staging");
  });
});

describe("the graph read", () => {
  test("a member with no stack-export.json reads its nodes from the store's export", async () => {
    const dir = unexportedStack();
    const store = localStore();
    expect(readPulumiMember({ member: { dir, label: "web" } }).report.exported).toBe(false);
    await writePulumiExportSnapshot({ dir, stack: "floci", environment: "prod", engine: "pulumi", run: engine().run, store });
    const stored = await readStoredPulumiExport({ dir, stack: "floci", store });
    const read = readPulumiMember({ member: { dir, label: "web" }, stored: { doc: stored!.doc, where: stored!.where, key: stored!.key } });
    expect(read.report).toMatchObject({ exported: true, exportSource: "store", export: `${store.where}:prod/floci__pulumi-export` });
    expect(read.entities.size).toBeGreaterThan(0);
  });

  test("a member with only a checked-in export reads as before", () => {
    const read = readPulumiMember({ member: { dir: join(testdata, "pulumi-preview"), label: "web" } });
    expect(read.report).toMatchObject({ exported: true, exportSource: "file", export: "stack-export.json" });
  });
});

describe("pulumi-up writes it after up", () => {
  test("stock: preview, up, stack output, then stack export into the store", async () => {
    const dir = unexportedStack();
    const store = localStore();
    const pulumi = engine();
    const cap = createPulumiUpCapability({ run: pulumi.run, env: {}, tmp: tmp(), snapshots: store });
    const out = await cap.run(ctx, { dir, stack: "floci", engine: "pulumi" });
    expect(pulumi.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["preview --json", "up --yes", "stack output", "stack export"]);
    expect(out.exportSnapshot).toMatchObject({ written: true, key: "prod/floci__pulumi-export" });
    expect((await readStoredPulumiExport({ dir, stack: "floci", store }))?.environment).toBe("prod");
  });

  test("a failed export leaves the apply standing", async () => {
    const dir = unexportedStack();
    const base = engine();
    const run: PulumiRunner = async (args, opts) => {
      if (args[0] === "stack" && args[1] === "export") throw Object.assign(new Error("exit 1"), { code: 1, stderr: "error: backend unreachable" });
      return base.run(args, opts);
    };
    const cap = createPulumiUpCapability({ run, env: {}, tmp: tmp(), snapshots: localStore() });
    const out = await cap.run(ctx, { dir, stack: "floci", engine: "pulumi" });
    expect(out.exportSnapshot).toMatchObject({ written: false, reason: expect.stringMatching(/backend unreachable/) });
    expect(out.outputs).toBeDefined();
  });
});
