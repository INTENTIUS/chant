/**
 * #5419: `workspace status` lists `stageQueues` for every stage of each
 * member's pipeline in one read, and attaches each queue to the member whose
 * pipeline it belongs to, also when several members share one ledger. Temp
 * repos whose stage logs the real writer fills; nothing is pushed.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanupTestDir, createTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020";
import statusSchema from "./status.schema.json";
import { workspaceStatus, type StatusDocument } from "./status";
import { gitStageLogPort, type StageLine } from "../lifecycle/stage-log";
import { STATUS_STAGE_QUEUES_FLOOR } from "../pipeline";
import { NEXT_RELEASE } from "../release-floors";

const validateStatus = new Ajv2020({ strict: true, allErrors: true }).compile(statusSchema);
const NOW = "2026-11-20T12:00:00.000Z";
const at = (h: number) => new Date(Date.parse(NOW) + h * 3_600_000).toISOString();

const pipelineSource = (name: string, stages: string[]) => `import { pipeline } from "@intentius/chant/pipeline";

export default pipeline({
  name: "${name}",
  defaults: { op: "${name}", step: { kind: "pulumi-up", stack: "{target}" }, runner: "ubuntu-latest" },
  stages: [
${stages.map((s, i) => `    { name: "${s}", ${i > 0 ? `after: ["${stages[i - 1]}"], queue: "one-at-a-time", ` : ""}waves: [{ name: "${s}", runs: [{ target: "${s}" }] }], gate: { policy: "never" } },`).join("\n")}
  ],
});
`;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

type Doc = Extract<StatusDocument, { members: unknown }>;

function result(doc: StatusDocument): Doc {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  expect(validateStatus(doc), JSON.stringify(validateStatus.errors, null, 2)).toBe(true);
  return doc;
}

const line = (op: string, stage: string, kind: StageLine["kind"], digest: string, timestamp: string, more: Partial<StageLine> = {}): StageLine => ({ version: 1, kind, op, stage, digest, label: digest.replace("sha256:", ""), timestamp, ...more });

/**
 * A workspace of three members on the one flat ledger: `api` and `web` each
 * declare a pipeline, `tools` declares none. Each pipeline's log holds its own
 * releases, so a queue shows under another member only when status mixes them.
 */
async function setup(dir: string): Promise<void> {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@chant.dev");
  git(dir, "config", "user.name", "T");
  const members = [
    { name: "api", dir: "api", kind: "other", because: "the fixture" },
    { name: "web", dir: "web", kind: "other", because: "the fixture" },
    { name: "tools", dir: "tools", kind: "other", because: "the fixture" },
  ];
  writeFileSync(join(dir, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, members }, null, 2));
  for (const [member, source] of [
    ["api", pipelineSource("api-shop", ["dev", "canary", "prod"])],
    ["web", pipelineSource("web-site", ["staging", "live"])],
  ] as const) {
    mkdirSync(join(dir, member, ".chant"), { recursive: true });
    writeFileSync(join(dir, member, ".chant", "pipeline.ts"), source);
  }
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "tools", "README.md"), "tools\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");

  const log = gitStageLogPort({ cwd: dir });
  // api-shop: v1 is in prod, v2 waits behind it and v3 replaced v2; v3 is also in the canary.
  for (const l of [
    line("api-shop", "prod", "entered", "sha256:a1", at(-5)),
    line("api-shop", "prod", "waiting", "sha256:a2", at(-4)),
    line("api-shop", "prod", "replaced", "sha256:a2", at(-3), { by: "sha256:a3", byLabel: "a3" }),
    line("api-shop", "prod", "waiting", "sha256:a3", at(-3)),
    line("api-shop", "canary", "entered", "sha256:a3", at(-2)),
  ]) await log.append(l);
  // web-site: one release waits for live; staging has no line yet.
  for (const l of [line("web-site", "live", "entered", "sha256:w1", at(-6)), line("web-site", "live", "waiting", "sha256:w2", at(-1))]) await log.append(l);
}

const dirs: string[] = [];
let doc: Doc;
let byStage: Doc;
let onlyDev: Doc;

const member = (d: Doc, name: string) => d.members.find((m) => m.name === name)!;

beforeAll(async () => {
  const dir = await createTestDir("chant-status-queues");
  dirs.push(dir);
  await setup(dir);
  const before = git(dir, "rev-parse", "chant/lifecycle");
  doc = result(await workspaceStatus({ cwd: dir, env: "prod", now: NOW }));
  byStage = result(await workspaceStatus({ cwd: dir, env: "staging", now: NOW }));
  onlyDev = result(await workspaceStatus({ cwd: dir, env: "dev", now: NOW }));
  expect(git(dir, "rev-parse", "chant/lifecycle")).toBe(before);
}, 300_000);

afterAll(async () => {
  for (const d of dirs) await cleanupTestDir(d);
});

describe("stage queues for every stage, on their own member (#5419)", () => {
  test("a member's queues cover every stage of its pipeline in pipeline order, whatever environment was asked for", () => {
    for (const d of [doc, byStage, onlyDev]) {
      expect(member(d, "api").stageQueues?.map((q) => q.stage)).toEqual(["dev", "canary", "prod"]);
      expect(member(d, "web").stageQueues?.map((q) => q.stage)).toEqual(["staging", "live"]);
    }
  });

  test("a stage the log has not met lists an empty queue", () => {
    const api = member(doc, "api").stageQueues!;
    expect(api.find((q) => q.stage === "dev")).toEqual({ pipeline: "api-shop", stage: "dev", inStage: null, waiting: [], replaced: [] });
    const web = member(doc, "web").stageQueues!;
    expect(web.find((q) => q.stage === "staging")).toEqual({ pipeline: "web-site", stage: "staging", inStage: null, waiting: [], replaced: [] });
  });

  test("each queue holds the release in the stage, the ones waiting and the ones replaced", () => {
    const prod = member(doc, "api").stageQueues!.find((q) => q.stage === "prod")!;
    expect(prod.inStage).toMatchObject({ digest: "sha256:a1", label: "a1" });
    expect(prod.waiting.map((w) => w.digest)).toEqual(["sha256:a3"]);
    expect(prod.replaced).toEqual([expect.objectContaining({ digest: "sha256:a2", by: "sha256:a3", byLabel: "a3" })]);
    const canary = member(doc, "api").stageQueues!.find((q) => q.stage === "canary")!;
    expect(canary.inStage).toMatchObject({ digest: "sha256:a3" });
    const live = member(doc, "web").stageQueues!.find((q) => q.stage === "live")!;
    expect(live.inStage).toMatchObject({ digest: "sha256:w1" });
    expect(live.waiting.map((w) => w.digest)).toEqual(["sha256:w2"]);
  });

  test("members on one shared ledger each list only their own pipeline's queues", () => {
    expect(member(doc, "api").gateLedger).toMatchObject({ layout: "flat", shared: true });
    expect(member(doc, "web").gateLedger).toMatchObject({ layout: "flat", shared: true });
    expect(new Set(member(doc, "api").stageQueues!.map((q) => q.pipeline))).toEqual(new Set(["api-shop"]));
    expect(new Set(member(doc, "web").stageQueues!.map((q) => q.pipeline))).toEqual(new Set(["web-site"]));
    // Nothing of api-shop's shows under web, and nothing of web-site's under api.
    expect(member(doc, "web").stageQueues!.some((q) => q.inStage?.digest.startsWith("sha256:a") || q.waiting.some((w) => w.digest.startsWith("sha256:a")))).toBe(false);
    expect(member(doc, "api").stageQueues!.some((q) => q.inStage?.digest.startsWith("sha256:w") || q.waiting.some((w) => w.digest.startsWith("sha256:w")))).toBe(false);
  });

  test("a member with no pipeline on a shared ledger lists no queues", () => {
    expect(member(doc, "tools").stageQueues).toBeUndefined();
    expect(member(doc, "tools").pipeline).toBeUndefined();
  });

  test("the capability carries its floor", () => {
    expect(STATUS_STAGE_QUEUES_FLOOR).toBe(NEXT_RELEASE);
  });
});
