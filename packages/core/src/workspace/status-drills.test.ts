/**
 * #5450: `workspace status` shows the newest restore drill of each store and
 * whether it met its targets. A temp repo whose drill ledger the real writer
 * fills; nothing is pushed.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanupTestDir, createTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020";
import statusSchema from "./status.schema.json";
import { formatStatus, workspaceStatus, type StatusDocument } from "./status";
import { drillRows, readMemberDrills } from "./status-drills";
import { appendDrillRecord } from "../lifecycle/drill-ledger";
import { formatSpan, type DrillRecord } from "../lifecycle/drill-record";

const validateStatus = new Ajv2020({ strict: true, allErrors: true }).compile(statusSchema);
const NOW = "2026-11-21T12:00:00.000Z";
const H = 3_600_000;
const M = 60_000;

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

const rec = (store: string, env: string, ended: string, more: Partial<DrillRecord> = {}): DrillRecord => ({
  version: 1,
  id: `${store}-${ended}`,
  store,
  kind: "rds",
  env,
  op: `${store}-restore-drill`,
  scratch: `drill-${store}-1`,
  started: ended,
  ended,
  backup: { id: "snap", at: "2026-11-21T00:00:00.000Z" },
  rtoMs: 3 * H,
  restoreMs: 3 * H - 5 * M,
  rpoMs: 10 * M,
  targets: { rtoMs: 4 * H, rpoMs: 15 * M },
  met: true,
  shortfall: {},
  outcome: "passed",
  checks: [{ name: "rows", kind: "command", ok: true, durationMs: 5 * M }],
  tornDown: true,
  ...more,
});

const dirs: string[] = [];
let dir: string;

beforeAll(async () => {
  dir = await createTestDir("chant-status-drills");
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@chant.dev");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, members: [{ name: "api", dir: "api", kind: "other", because: "the fixture" }, { name: "web", dir: "web", kind: "other", because: "the fixture" }] }, null, 2));
  for (const m of ["api", "web"]) {
    mkdirSync(join(dir, m), { recursive: true });
    writeFileSync(join(dir, m, "README.md"), `${m}\n`);
  }
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  // The drills of the flat ledger, which both members read.
  await appendDrillRecord(rec("orders", "prod", "2026-11-14T03:00:00.000Z"), { cwd: dir });
  await appendDrillRecord(rec("orders", "prod", "2026-11-21T03:00:00.000Z", { outcome: "missed", met: false, rtoMs: 5 * H, shortfall: { rtoMs: H } }), { cwd: dir });
  await appendDrillRecord(rec("sessions", "prod", "2026-11-20T03:00:00.000Z", { kind: "dynamodb", outcome: "failed", rtoMs: null, met: null, error: "restore refused", checks: [{ name: "rows", kind: "command", ok: false, durationMs: 1, detail: "printed 0" }] }), { cwd: dir });
  await appendDrillRecord(rec("orders", "staging", "2026-11-21T04:00:00.000Z"), { cwd: dir });
}, 300_000);

afterAll(async () => {
  for (const d of dirs) await cleanupTestDir(d);
});

describe("workspace status shows the newest drill of each store (#5450)", () => {
  test("one entry per store in the environment asked for, the newest one, and the ledger is left as it was", async () => {
    const before = git(dir, "rev-parse", "chant/lifecycle");
    const doc = result(await workspaceStatus({ cwd: dir, env: "prod", now: NOW }));
    expect(git(dir, "rev-parse", "chant/lifecycle")).toBe(before);
    const api = doc.members.find((m) => m.name === "api")!;
    expect(api.drills?.map((d) => [d.store, d.outcome, d.met])).toEqual([["orders", "missed", false], ["sessions", "failed", null]]);
    expect(api.drills![0]).toMatchObject({ rtoMs: 5 * H, rpoMs: 10 * M, targets: { rtoMs: 4 * H, rpoMs: 15 * M }, shortfall: { rtoMs: H }, at: "2026-11-21T03:00:00.000Z", backup: { id: "snap" }, checks: { passed: 1, total: 1, failed: [] } });
    expect(api.drills![1]).toMatchObject({ rtoMs: null, error: "restore refused", checks: { passed: 0, total: 1, failed: ["rows"] } });
  });

  test("another environment reads its own drills", async () => {
    const doc = result(await workspaceStatus({ cwd: dir, env: "staging", now: NOW }));
    expect(doc.members[0].drills?.map((d) => [d.store, d.outcome])).toEqual([["orders", "passed"]]);
  });

  test("an environment with no drill has no drills field", async () => {
    const doc = result(await workspaceStatus({ cwd: dir, env: "dev", now: NOW }));
    expect(doc.members[0].drills).toBeUndefined();
  });

  test("the text view lists a row per store with the measurement against the target", async () => {
    const doc = result(await workspaceStatus({ cwd: dir, env: "prod", now: NOW }));
    const text = formatStatus(doc);
    expect(text).toMatch(/orders \(rds\)\s+2026-11-21T03:00:00.000Z\s+missed targets\s+5h of 4h\s+10m of 15m\s+1\/1/);
    expect(text).toMatch(/sessions \(dynamodb\)\s+2026-11-20T03:00:00.000Z\s+failed\s+-\s+10m of 15m\s+0\/1/);
  });
});

describe("readMemberDrills", () => {
  const read = (text: string | null) => async () => text;

  test("no ledger branch or no file is no drills", async () => {
    expect(await readMemberDrills({ prefix: "", env: "prod", commit: null, cwd: dir })).toEqual({ drills: [], malformed: 0 });
    expect(await readMemberDrills({ prefix: "", env: "prod", commit: "abc", cwd: dir, read: read(null) })).toEqual({ drills: [], malformed: 0 });
  });

  test("a member's drills are read under its prefix, and a line that is not a drill is counted", async () => {
    const paths: string[] = [];
    const out = await readMemberDrills({
      prefix: "_members/api/",
      env: "prod",
      commit: "abc",
      cwd: dir,
      read: async (p) => {
        paths.push(p);
        return `${JSON.stringify(rec("orders", "prod", "2026-11-21T03:00:00.000Z"))}\nbroken\n`;
      },
    });
    expect(paths).toEqual(["_members/api/prod/drills.jsonl"]);
    expect(out.drills.map((d) => d.store)).toEqual(["orders"]);
    expect(out.malformed).toBe(1);
  });

  test("a drill that left scratch behind says so in its row", () => {
    const rows = drillRows([{ name: "api", drills: [{ store: "o", kind: "rds", env: "prod", id: "i", op: null, at: "t", outcome: "passed", met: true, rtoMs: H, rpoMs: M, targets: { rtoMs: 4 * H }, shortfall: {}, checks: { passed: 0, total: 0, failed: [] }, backup: null, error: null, tornDown: false }] }], formatSpan);
    expect(rows[1]).toEqual(["api", "o (rds)", "t", "met targets, scratch left", "1h of 4h", "1m", "0/0"]);
  });
});
