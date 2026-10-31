/**
 * The pulumi lexicon's `readDrift` (#4455), what `chant workspace drift
 * --member <pulumi member>` reaches through `chant lifecycle drift` in the
 * member's reader project: it dispatches to #4453's runner and adapters,
 * `pulumi refresh --preview-only --target` per resource on a stock member
 * and `plunge drift --resource --stream` on a member on plunge, and wraps
 * the records in one stream. The runners are fakes over the fixtures recorded
 * for #4475 (pulumi 3.272.0 and plunge on floci, see testdata's READMEs);
 * `plunge-member`'s export is a cut of the recorded plunge stack's. No binary
 * runs here.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createSnapshotStore } from "@intentius/chant/lifecycle/snapshot-store";
import { foldDriftLines, type ReadDriftOptions } from "@intentius/chant/drift-record";
import { readPulumiDrift } from "./drift-read";
import { pulumiPlugin } from "./plugin";
import type { PulumiRunner } from "./run";
import { writePulumiExportSnapshot } from "./stack-export-snapshot";

const testdata = join(import.meta.dirname, "testdata");
const text = (...path: string[]) => readFileSync(join(testdata, ...path), "utf-8");
const AT = "2026-10-25T12:00:00Z";
const bucket = "urn:pulumi:floci::corpus-aws-ts::aws:s3/bucket:Bucket::site-bucket";
const assets = "urn:pulumi:floci::corpus-aws-ts::corpus:index:Site$aws:s3/bucket:Bucket::docs-assets";
const role = "urn:pulumi:floci::corpus-aws-ts::aws:iam/role:Role::app-role";

function fake(answer: (args: string[]) => string): { run: PulumiRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      return { stdout: answer(args) };
    },
  };
}

const never = fake(() => {
  throw new Error("this binary must not run");
});

function options(dir: string, extra: Partial<ReadDriftOptions> = {}): ReadDriftOptions {
  return { member: "site", projectRoot: dir, config: { pulumi: { member: { dir, label: "site" } } }, observedAt: AT, ...extra };
}

describe("readPulumiDrift", () => {
  test("the plugin has a drift read", () => {
    expect(typeof pulumiPlugin.readDrift).toBe("function");
  });

  test("--resource on a stock member: one refresh --preview-only --target, as one stream", async () => {
    const pulumi = fake(() => text("pulumi-refresh", "bucket-edited.json"));
    const dir = join(testdata, "pulumi-preview");
    const answer = await readPulumiDrift(options(dir, { resource: bucket }), { run: pulumi.run, plunge: never.run });
    if (!("lines" in answer)) throw new Error(JSON.stringify(answer));
    expect(pulumi.calls).toEqual([["refresh", "--preview-only", "--json", "--stack", "floci", "--target", bucket]]);
    expect(answer.lines.map((l) => l.type)).toEqual(["drift-start", "drift-record", "drift-settle"]);
    expect(answer.lines[0]).toMatchObject({ member: "site", engine: "pulumi", read: "refresh", resource: bucket, expected: [bucket] });
    const { document } = foldDriftLines(answer.lines);
    expect(document.records.map((r) => [r.address, r.status])).toEqual([[bucket, "drifted"]]);
  });

  test("a member on plunge reads each resource in its export with plunge drift --resource --stream, never pulumi", async () => {
    const docs = "urn:pulumi:floci::corpus-aws-ts::corpus:index:Site::docs";
    const answers: Record<string, string> = { [assets]: "assets-drifted.ndjson", [role]: "role-in-sync.ndjson", [docs]: "component-unsupported.ndjson" };
    const plunge = fake((args) => text("plunge-drift", answers[args[2]]));
    const dir = join(testdata, "plunge-member");
    const answer = await readPulumiDrift(options(dir), { run: never.run, plunge: plunge.run });
    if (!("lines" in answer)) throw new Error(JSON.stringify(answer));
    expect(plunge.calls).toEqual([role, docs, assets].map((u) => ["drift", "--resource", u, "--stream", "--stack", "floci", "--member", "site"]));
    expect(answer.lines[0]).toMatchObject({ engine: "plunge", read: "refresh" });
    const { document } = foldDriftLines(answer.lines);
    // plunge answers a component, which no provider reads, with not-observed (recorded).
    expect(document.records.map((r) => [r.address, r.status]).sort()).toEqual([
      [role, "in-sync"],
      [docs, "not-observed"],
      [assets, "drifted"],
    ].sort());
  });

  test("--resource on a member on plunge reads that URN alone", async () => {
    const plunge = fake(() => text("plunge-drift", "assets-drifted.ndjson"));
    const answer = await readPulumiDrift(options(join(testdata, "plunge-member"), { resource: assets }), { run: never.run, plunge: plunge.run });
    expect("lines" in answer).toBe(true);
    expect(plunge.calls).toEqual([["drift", "--resource", assets, "--stream", "--stack", "floci", "--member", "site"]]);
  });

  test("--stack is the member's declared stack, over the one its export names (#4496)", async () => {
    const pulumi = fake(() => text("pulumi-refresh", "bucket-edited.json"));
    const dir = join(testdata, "pulumi-preview");
    const config = { pulumi: { member: { dir, label: "site", stack: "staging" } } };
    const answer = await readPulumiDrift({ ...options(dir, { resource: bucket }), config }, { run: pulumi.run, plunge: never.run });
    expect("lines" in answer).toBe(true);
    expect(pulumi.calls).toEqual([["refresh", "--preview-only", "--json", "--stack", "staging", "--target", bucket]]);
  });

  test("a read other than refresh is refused, and so is a project with no pulumi member", async () => {
    const dir = join(testdata, "pulumi-preview");
    expect(await readPulumiDrift(options(dir, { read: "state" }), { run: never.run })).toEqual({
      refused: { code: "read-unsupported", message: "a Pulumi member answers refresh, not state" },
    });
    const none = await readPulumiDrift({ member: "site", projectRoot: dir, config: {}, observedAt: AT });
    expect("refused" in none && none.refused.code).toBe("no-drift-read");
    expect(never.calls).toEqual([]);
  });
});

describe("readPulumiDrift with --stack", () => {
  const exportText = text("pulumi-preview", "stack-export.json");

  /** A member directory with Pulumi.yaml and no checked-in export, and a store holding the stacks named. */
  async function memberWithStore(stacks: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "pulumi-drift-stack-"));
    cpSync(join(testdata, "pulumi-preview", "Pulumi.yaml"), join(dir, "Pulumi.yaml"));
    mkdirSync(join(dir, "node_modules"));
    const store = createSnapshotStore({ store: "local", dir: mkdtempSync(join(tmpdir(), "pulumi-drift-store-")) });
    for (const stack of stacks) {
      const wrote = await writePulumiExportSnapshot({
        dir,
        stack,
        environment: "prod",
        engine: "pulumi",
        run: async () => ({ stdout: exportText }),
        store,
      });
      expect(wrote.written, JSON.stringify(wrote)).toBe(true);
    }
    return { dir, store };
  }

  test("reads the named stack's stored export and passes that stack to every refresh", async () => {
    const { dir, store } = await memberWithStore(["staging", "prod-eu"]);
    const pulumi = fake(() => text("pulumi-refresh", "bucket-edited.json"));
    const answer = await readPulumiDrift(options(dir, { stack: "prod-eu" }), { run: pulumi.run, plunge: never.run, exportStore: store });
    if (!("lines" in answer)) throw new Error(JSON.stringify(answer));
    expect(pulumi.calls.length).toBeGreaterThan(0);
    for (const call of pulumi.calls) expect(call.slice(call.indexOf("--stack"), call.indexOf("--stack") + 2)).toEqual(["--stack", "prod-eu"]);
  });

  test("beats the member's declared stack", async () => {
    const { dir, store } = await memberWithStore(["staging", "prod-eu"]);
    const pulumi = fake(() => text("pulumi-refresh", "bucket-edited.json"));
    const config = { pulumi: { member: { dir, label: "site", stack: "staging" } } };
    const answer = await readPulumiDrift({ ...options(dir, { stack: "prod-eu", resource: bucket }), config }, { run: pulumi.run, plunge: never.run, exportStore: store });
    expect("lines" in answer).toBe(true);
    expect(pulumi.calls).toEqual([["refresh", "--preview-only", "--json", "--stack", "prod-eu", "--target", bucket]]);
  });

  test("a store with no export for that stack is an error naming the stack, and nothing runs", async () => {
    const { dir, store } = await memberWithStore(["staging"]);
    const spy = fake(() => text("pulumi-refresh", "bucket-edited.json"));
    const answer = await readPulumiDrift(options(dir, { stack: "prod-eu" }), { run: spy.run, plunge: never.run, exportStore: store });
    expect(answer).toMatchObject({ refused: { code: "no-drift-read" } });
    expect("refused" in answer && answer.refused.message).toMatch(/holds no export for stack prod-eu of site/);
    expect(spy.calls).toEqual([]);
  });

  test("an empty store is refused too, though a checked-in export sits beside the member", async () => {
    const dir = join(testdata, "pulumi-preview");
    const store = createSnapshotStore({ store: "local", dir: mkdtempSync(join(tmpdir(), "pulumi-drift-store-")) });
    const spy = fake(() => text("pulumi-refresh", "bucket-edited.json"));
    const answer = await readPulumiDrift(options(dir, { stack: "floci" }), { run: spy.run, plunge: never.run, exportStore: store });
    expect(answer).toMatchObject({ refused: { code: "no-drift-read" } });
    expect(spy.calls).toEqual([]);
  });

  test("without --stack the read is as before: the checked-in export when the store has none", async () => {
    const dir = join(testdata, "pulumi-preview");
    const store = createSnapshotStore({ store: "local", dir: mkdtempSync(join(tmpdir(), "pulumi-drift-store-")) });
    const pulumi = fake(() => text("pulumi-refresh", "bucket-edited.json"));
    const answer = await readPulumiDrift(options(dir, { resource: bucket }), { run: pulumi.run, plunge: never.run, exportStore: store });
    expect("lines" in answer).toBe(true);
    expect(pulumi.calls).toEqual([["refresh", "--preview-only", "--json", "--stack", "floci", "--target", bucket]]);
  });
});
