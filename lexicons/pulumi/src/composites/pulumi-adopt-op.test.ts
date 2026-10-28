/**
 * PulumiAdoptOp (#4562) and its activities. The adopt documents are built
 * from plunge's `AdoptView` (`pkg/backend/plunge`, fields as its JSON tags
 * spell them), not recorded; a floci recording of `plunge stack adopt
 * --json` replaces them when the epic's runs are made. The runners and the
 * bucket check are fakes, so no binary runs and no bucket is read.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { validateActivitySteps, type ActivityContract, type ActivityStep, type GateStep, type OpConfig } from "@intentius/chant/op";
import type { BucketReport } from "@intentius/chant/bucket-check";
import { adoptBucketTarget, parsePlungeAdoptView, pulumiAdoptDigest } from "../adopt";
import { PulumiAdoptOp } from "./pulumi-adopt-op";
import {
  pulumiAdoptCheckContract,
  pulumiAdoptContract,
  pulumiAdoptExportContract,
  pulumiAdoptPreviewContract,
} from "../op/activity-contracts";
import { adoptCheck, adoptExport, adoptPreview, adoptStack } from "../op/activities/pulumi-adopt";
import type { PulumiRunner } from "../run";

const exportText = readFileSync(join(import.meta.dirname, "..", "testdata", "pulumi-preview", "stack-export.json"), "utf-8");

const urn = (type: string, name: string) => `urn:pulumi:dev::shop::${type}::${name}`;
const view = (status: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    adopt: "v1",
    stack: "organization/shop/dev",
    status,
    checkpoint: { source: "the DIY checkpoint", digest: "sha256:abc" },
    resources: [
      { urn: urn("aws:s3/bucketV2:BucketV2", "assets"), type: "aws:s3/bucketV2:BucketV2", id: "assets-123", fate: "pending", marked: false, reason: "adoption loads no provider schema" },
      { urn: urn("aws:iam/role:Role", "app"), type: "aws:iam/role:Role", id: "app-role", fate: "pending", marked: false },
    ],
    refusals: [],
    ...extra,
  });

function props(config: Parameters<typeof PulumiAdoptOp>[0]): OpConfig {
  return (PulumiAdoptOp(config).op as unknown as { props: OpConfig }).props;
}

const contracts = new Map<string, ActivityContract>([
  ["pulumiAdoptCheck", pulumiAdoptCheckContract],
  ["pulumiAdoptExport", pulumiAdoptExportContract],
  ["pulumiAdoptPreview", pulumiAdoptPreviewContract],
  ["pulumiAdopt", pulumiAdoptContract],
]);

describe("PulumiAdoptOp", () => {
  test("one stack: Check, Export, Preview, a gate bound to the preview's digest, Adopt", () => {
    const op = props({ name: "adopt-infra", stacks: [{ member: "infra", dir: "./infra", stack: "dev" }] });
    expect(op.phases.map((p) => p.name)).toEqual(["Check", "Export", "Preview", "Gate", "Adopt"]);
    const gate = op.phases[3]!.steps[0] as GateStep;
    expect(gate.gate).toBe("approve-adopt-infra");
    expect(gate.plan).toMatchObject({ step: "preview-0", path: "planDigest" });
    const adopt = op.phases[4]!.steps[0] as ActivityStep;
    expect(adopt.fn).toBe("pulumiAdopt");
    expect(adopt.args?.file).toBeUndefined();
    expect(op.labels).toMatchObject({ Adopt: "true", Surface: "pulumi-adopt" });
  });

  test("several stacks: one wave each, a gate per stack", () => {
    const op = props({
      name: "adopt",
      stacks: [
        { member: "net", dir: "./net", stack: "prod" },
        { member: "app", dir: "./app", stack: "prod", from: { backend: "https://api.pulumi.com" } },
      ],
    });
    expect(op.phases.map((p) => p.name)).toEqual(["Check", "Export", "Preview net/prod", "Gate net/prod", "Adopt net/prod", "Preview app/prod", "Gate app/prod", "Adopt app/prod"]);
    expect(op.phases[0]!.steps).toHaveLength(2);
    expect((op.phases[3]!.steps[0] as GateStep).gate).toBe("approve-adopt-net-prod");
    // The route from Pulumi Cloud adopts the Export step's file.
    const preview = op.phases[5]!.steps[0] as ActivityStep;
    expect(preview.args?.file).toMatchObject({ step: "export-1", path: "file" });
  });

  test("its steps validate against the activities' contracts", () => {
    const op = props({
      name: "adopt",
      stacks: [
        { member: "infra", dir: "./infra", stack: "dev", backend: "plunge+s3://state?region=us-east-1", allowInsecure: ["lifecycle"] },
        { member: "web", dir: "./web", stack: "dev", from: { file: "./web/dev.json" } },
      ],
    });
    expect(validateActivitySteps(op, contracts)).toEqual([]);
  });

  test("compensate without a command, an empty list and a stack listed twice are refused when built", () => {
    expect(() => props({ name: "a", stacks: [{ member: "m", dir: ".", stack: "s" }], compensate: true })).toThrow(/no automatic undo/);
    expect(() => props({ name: "a", stacks: [] })).toThrow(/stacks is empty/);
    expect(() => props({ name: "a", stacks: [{ member: "m", dir: ".", stack: "s" }, { member: "m", dir: "./x", stack: "s" }] })).toThrow(/listed twice/);
  });
});

describe("the adopt document and its digest", () => {
  test("the digest ignores status, so the approved preview and the --yes run agree", () => {
    const preview = parsePlungeAdoptView(view("would-adopt"))!;
    const adopted = parsePlungeAdoptView(view("adopted"))!;
    expect(pulumiAdoptDigest(preview)).toBe(pulumiAdoptDigest(adopted));
  });

  test("a changed checkpoint or resource moves it", () => {
    const base = pulumiAdoptDigest(parsePlungeAdoptView(view("would-adopt"))!);
    expect(pulumiAdoptDigest(parsePlungeAdoptView(view("would-adopt", { checkpoint: { digest: "sha256:def" } }))!)).not.toBe(base);
    expect(parsePlungeAdoptView("not json")).toBeUndefined();
    expect(parsePlungeAdoptView(JSON.stringify({ status: "maybe" }))).toBeUndefined();
  });
});

describe("the bucket target from the backend URL", () => {
  test("s3 gives bucket, region and the path as namespace; an endpoint needs static keys", () => {
    expect(adoptBucketTarget("plunge+s3://state/stacks?region=us-east-1&allow_insecure=lifecycle", {})).toEqual({
      target: { store: "s3", bucket: "state", region: "us-east-1" },
      namespaces: ["stacks/"],
      waived: ["lifecycle"],
    });
    expect(adoptBucketTarget("plunge+s3://state?region=us-east-1&endpoint=http://localhost:4566", {})).toMatchObject({ refuse: expect.stringMatching(/static keys/) });
    expect(
      adoptBucketTarget("plunge+s3://state?region=us-east-1&endpoint=http://localhost:4566", { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" }),
    ).toMatchObject({ target: { endpoint: "http://localhost:4566", credentials: { accessKeyId: "test" } } });
    expect(adoptBucketTarget("plunge+s3://state", {})).toMatchObject({ refuse: expect.stringMatching(/no region/) });
  });

  test("file is skipped, azblob is refused without a bucket, gs is read", () => {
    expect(adoptBucketTarget("plunge+file:///tmp/state", {})).toMatchObject({ skip: expect.stringMatching(/no bucket/) });
    expect(adoptBucketTarget("plunge+azblob://state", {})).toMatchObject({ refuse: expect.stringMatching(/subscription/) });
    expect(adoptBucketTarget("plunge+gs://state", { PLUNGE_ALLOW_INSECURE: "object_versioning" })).toMatchObject({ target: { store: "gcs", bucket: "state" }, waived: ["object_versioning"] });
  });
});

function report(verdicts: Record<string, "ok" | "fail">, unwaivable: string[] = []): BucketReport {
  return {
    store: "s3",
    bucket: "state",
    namespaces: [],
    correct: Object.values(verdicts).every((v) => v === "ok"),
    settings: Object.entries(verdicts).map(([setting, verdict]) => ({
      setting: setting as BucketReport["settings"][number]["setting"],
      verdict,
      found: `${setting} is ${verdict}`,
      unwaivable: unwaivable.includes(setting),
      ...(verdict === "fail" ? { fix: `fix ${setting}` } : {}),
    })),
  };
}

describe("the activities", () => {
  const stack = { member: "infra", dir: "/tmp", stack: "dev" };

  test("check refuses a failing setting by name with its fix, honours a waiver, never an unwaivable one", async () => {
    const failing = async () => report({ versioning: "ok", lifecycle: "fail", public_access_block: "ok" });
    const args = { ...stack, backend: "plunge+s3://state?region=us-east-1" };
    await expect(adoptCheck(args, { env: {}, checkBucket: failing })).rejects.toThrow(/refusing to adopt "infra\/dev".*lifecycle \(fail\).*fix lifecycle/);
    expect(await adoptCheck({ ...args, allowInsecure: ["lifecycle"] }, { env: {}, checkBucket: failing })).toMatchObject({ checked: true, waived: ["lifecycle"] });
    const current = async () => report({ versioning: "ok", lifecycle: "fail", public_access_block: "ok" }, ["lifecycle"]);
    await expect(adoptCheck({ ...args, allowInsecure: ["lifecycle"] }, { env: {}, checkBucket: current })).rejects.toThrow(/no waiver reaches it/);
    expect(await adoptCheck({ ...stack, backend: "plunge+file:///tmp/s" }, { env: {} })).toMatchObject({ checked: false });
  });

  test("export runs stock pulumi stack export against the stock root and keeps it mode 600", async () => {
    const calls: { args: string[]; env?: Record<string, string> }[] = [];
    const run: PulumiRunner = async (args, opts) => {
      calls.push({ args, ...(opts.env ? { env: opts.env } : {}) });
      return { stdout: exportText };
    };
    const tmp = mkdtempSync(join(tmpdir(), "adopt-test-"));
    const out = await adoptExport({ ...stack, backend: "plunge+s3://state?region=us-east-1" }, { run, env: {}, tmp });
    expect(calls).toEqual([{ args: ["stack", "export", "--stack", "dev"], env: { PULUMI_BACKEND_URL: "s3://state?region=us-east-1" } }]);
    expect(out).toMatchObject({ adoptFromFile: false, source: "s3://state?region=us-east-1" });
    expect(out.resources).toBeGreaterThan(0);
    expect(statSync(out.file).mode & 0o777).toBe(0o600);
    expect(readFileSync(out.file, "utf-8")).toBe(exportText);
  });

  test("export from Pulumi Cloud adopts from the file, and a given file runs nothing", async () => {
    const calls: { env?: Record<string, string> }[] = [];
    const run: PulumiRunner = async (_args, opts) => {
      calls.push(opts.env ? { env: opts.env } : {});
      return { stdout: exportText };
    };
    const tmp = mkdtempSync(join(tmpdir(), "adopt-test-"));
    expect(await adoptExport({ ...stack, from: { backend: "https://api.pulumi.com" } }, { run, env: {}, tmp })).toMatchObject({ adoptFromFile: true });
    expect(calls).toEqual([{ env: { PULUMI_BACKEND_URL: "https://api.pulumi.com" } }]);
    const given = join(tmp, "given.json");
    writeFileSync(given, exportText);
    expect(await adoptExport({ ...stack, from: { file: given } }, { run, env: {}, tmp })).toMatchObject({ file: given, source: "file", adoptFromFile: true });
    expect(calls).toHaveLength(1);
  });

  test("preview runs plunge stack adopt --json and fails on a refusal, naming it", async () => {
    const seen: string[][] = [];
    const ok: PulumiRunner = async (args) => {
      seen.push(args);
      return { stdout: view("would-adopt") };
    };
    const out = await adoptPreview({ ...stack, file: "/tmp/s.json" }, { plunge: ok });
    expect(seen).toEqual([["stack", "adopt", "--json", "--stack", "dev", "--file", "/tmp/s.json"]]);
    expect(out).toMatchObject({ status: "would-adopt", resources: 2, fates: { pending: 2 }, changed: true });
    const refused: PulumiRunner = async () => {
      throw Object.assign(new Error("exit 255"), { code: 255, stdout: view("refused", { refusals: [{ code: "pending-operations", reason: "the checkpoint has 1 pending operation" }] }) });
    };
    await expect(adoptPreview(stack, { plunge: refused })).rejects.toThrow(/pending-operations: the checkpoint has 1 pending operation\. Nothing was written/);
  });

  test("adopt runs the --yes form and says whether it matched the approved digest", async () => {
    const seen: string[][] = [];
    const plunge: PulumiRunner = async (args) => {
      seen.push(args);
      return { stdout: view("adopted") };
    };
    const approved = pulumiAdoptDigest(parsePlungeAdoptView(view("would-adopt"))!);
    const out = await adoptStack({ ...stack, planDigest: approved }, { plunge });
    expect(seen).toEqual([["stack", "adopt", "--json", "--yes", "--stack", "dev"]]);
    expect(out).toMatchObject({ status: "adopted", matchesApproved: true });
    const again = await adoptStack({ ...stack, planDigest: "sha256:other" }, { plunge: async () => ({ stdout: view("already-adopted") }) });
    expect(again).toMatchObject({ changed: false, matchesApproved: false });
  });
});
