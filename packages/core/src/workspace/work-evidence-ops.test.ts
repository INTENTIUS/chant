/**
 * Work evidence that cites an ops result (#3171), on a workspace built from
 * the reference workspace's work kind in a throwaway git repository.
 *
 * W-010 is in progress with a runtime criterion, "the web component runs
 * green in staging". The staging run ledger of `deploy-web` holds an `ok`
 * run, a `fail` run and a gated one. The run holding W-010's lease cites the
 * ok run, the citation verifies against the ledger, and the criterion is met.
 * The others, and citations the ledger does not hold, are refused and
 * nothing is written.
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { cleanScratch, contract, git, REPO, repo } from "./__fixtures__/contract-repo";
import { queryRecords } from "./records-cli";
import recordsSchema from "./records.schema.json";
import { attachWorkEvidence } from "./work-evidence";
import workEvidenceSchema from "./work-evidence.schema.json";
import { appendRunRecord } from "../lifecycle/run-ledger";
import { appendGateResolution } from "../lifecycle/gate-ledger";
import { persistReleasePlan } from "../lifecycle/plan-ledger";
import { claimWorkLease, releaseWorkLease } from "../lifecycle/work-lease";
import type { OpRunRecordInput } from "../op/runtime";

const REF = join(REPO, "reference-workspace");
const KIND = "work/work.kind.mjs";

function work(id: string, fields: Record<string, unknown>): string {
  const data = {
    schema: 1,
    id,
    title: `Work ${id}`,
    state: "in-progress",
    implements: [],
    needs: [],
    constrains: ["member:app"],
    evidence: [],
    owner: "alice",
    opened_on: "2026-10-23",
    closed_on: null,
    source: { kind: "workspace", member: "app" },
    supersedes: [],
    ...fields,
  };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

const run = (id: string, status: OpRunRecordInput["status"]): OpRunRecordInput => ({
  id,
  op: "deploy-web",
  env: "staging",
  started: "2026-10-23T10:00:00.000Z",
  ended: "2026-10-23T10:05:00.000Z",
  status,
  labels: { Env: "staging" },
  outcomes: {},
  phases: [{ name: "Apply", status: status === "fail" ? "fail" : "ok", steps: [] }],
});

let root: string;
let token: string;
const evidenceDoc = contract(workEvidenceSchema);
const records = contract(recordsSchema);

beforeAll(async () => {
  root = repo({
    "chant.workspace.json": JSON.stringify({
      name: "studio",
      schema: 1,
      members: [{ name: "app", dir: "app", kind: "other", because: "a plain Node server" }],
      records: [{ kind: "decisions/decision.kind.mjs" }, { kind: KIND }],
    }),
    "app/server.mjs": "export const port = 8080;\n",
    "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions/decision.kind.mjs"), "utf-8"),
    "decisions/decision.schema.json": readFileSync(join(REF, "decisions/decision.schema.json"), "utf-8"),
    [KIND]: readFileSync(join(REF, KIND), "utf-8"),
    "work/work.schema.json": readFileSync(join(REF, "work/work.schema.json"), "utf-8"),
    "work/W-010-staging.md": work("W-010", {
      acceptance: [
        { id: "AC-1", text: "The web component runs green in staging", verification: "runtime" },
        { id: "AC-2", text: "The release plan for staging has no deletes", verification: "runtime" },
      ],
    }),
  });
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "the work");
  for (const [id, status] of [["r-ok", "ok"], ["r-fail", "fail"], ["r-gated", "gated"]] as const) await appendRunRecord(run(id, status), { cwd: root });
  await appendGateResolution({ op: "deploy-web", gate: "promote", resolvedBy: "bob", timestamp: "2026-10-23T09:00:00.000Z" }, { cwd: root });
  await persistReleasePlan({ digest: "sha256:abc", deletes: [] }, { cwd: root });
  const claimed = await claimWorkLease("W-010", "box/verify@h1", { cwd: join(root, "work") });
  if (!claimed.ok) throw new Error(claimed.message);
  token = claimed.lease.token;
});

afterAll(async () => {
  await releaseWorkLease("W-010", "box/verify@h1", { cwd: join(root, "work"), token });
  cleanScratch();
});

const cite = (over: Partial<Parameters<typeof attachWorkEvidence>[0]>) =>
  attachWorkEvidence({ cwd: root, item: "W-010", holder: "box/verify@h1", token, criterion: "AC-1", result: "pass", title: "staging run", ...over });

async function w10() {
  const doc = await queryRecords({ kind: join(root, KIND), cwd: root, workGaps: false });
  records.expectValid(doc);
  if ("error" in doc || !("records" in doc)) throw new Error(JSON.stringify(doc));
  return doc.records.find((r) => r.id === "W-010")!;
}

describe("work evidence cites an ops result (#3171)", () => {
  test("refusals write nothing: a run the ledger lacks, a failed run as a pass, a gated run, a wrong hash, two kinds of evidence", async () => {
    const refused = async (over: Partial<Parameters<typeof attachWorkEvidence>[0]>, code: string) => {
      const doc = await cite(over);
      evidenceDoc.expectValid(doc);
      expect(doc).toMatchObject({ error: { code } });
    };
    await refused({ ops: { ledger: "run", env: "staging", op: "deploy-web", id: "r-nope" } }, "work-evidence-ops-missing");
    await refused({ ops: { ledger: "run", env: "prod", op: "deploy-web", id: "r-ok" } }, "work-evidence-ops-missing");
    await refused({ ops: { ledger: "run", env: "staging", op: "deploy-web", id: "r-fail" } }, "work-evidence-ops-mismatch");
    await refused({ ops: { ledger: "run", env: "staging", op: "deploy-web", id: "r-gated" } }, "work-evidence-ops-unfinished");
    await refused({ ops: { ledger: "run", env: "staging", op: "deploy-web", id: "r-ok", sha256: "0".repeat(64) } }, "work-evidence-ops-mismatch");
    await refused({ ops: { ledger: "run", env: "../x", op: "deploy-web", id: "r-ok" } as never }, "write-input-invalid");
    await refused({ ops: { ledger: "run", env: "staging", op: "deploy-web", id: "r-ok" }, url: "https://example.com/x" }, "write-usage-invalid");
    expect((await w10()).acceptance).toMatchObject({ met: 0, total: 2 });
  });

  test("a failed run cited as failing evidence is written, and does not meet the criterion", async () => {
    const doc = await cite({ result: "fail", ops: { ledger: "run", env: "staging", op: "deploy-web", id: "r-fail" } });
    evidenceDoc.expectValid(doc);
    expect(doc).toMatchObject({ evidence: { ops: { ledger: "run", outcome: "fail" }, result: "fail" }, acceptance: { met: 0 } });
  });

  test("an ok run in staging ticks the runtime criterion, and the entry names the ledger line by its hash", async () => {
    const doc = await cite({ ops: { ledger: "run", env: "staging", op: "deploy-web", id: "r-ok" } });
    evidenceDoc.expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    const line = git(root, "show", "chant/lifecycle:staging/runs__deploy-web.jsonl")
      .split("\n")
      .find((l) => l.includes('"r-ok"'))!
      .trim();
    const { createHash } = await import("node:crypto");
    expect(doc.evidence).toMatchObject({
      criterion: "AC-1",
      verification: "runtime",
      result: "pass",
      by: "box/verify@h1",
      ops: { ledger: "run", ref: "chant/lifecycle:staging/runs__deploy-web.jsonl", field: "id", value: "r-ok", env: "staging", outcome: "ok", sha256: createHash("sha256").update(line).digest("hex") },
    });
    expect(doc.acceptance).toMatchObject({ met: 1, total: 2 });
    // The record still validates against the reference work schema with the ops entry in it.
    const rec = await w10();
    expect(rec.valid).toBe(true);
    expect(rec.acceptance).toMatchObject({ met: 1, total: 2 });

    // Citing it again with the hash it was given verifies too.
    const again = await cite({ ops: { ledger: "run", env: "staging", op: "deploy-web", id: "r-ok", sha256: (doc.evidence.ops as { sha256: string }).sha256 } });
    expect("error" in again).toBe(false);
  });

  test("a release plan and a gate answer can be cited, and a plan or gate the branch lacks is refused", async () => {
    const plan = await cite({ criterion: "AC-2", title: "the staging plan", ops: { ledger: "plan", digest: "sha256:abc" } });
    evidenceDoc.expectValid(plan);
    expect(plan).toMatchObject({ evidence: { ops: { ledger: "plan", ref: "chant/lifecycle:_plans/sha256_abc.json", field: "digest", value: "sha256:abc" } }, acceptance: { met: 2, total: 2 } });
    const gate = await cite({ criterion: "AC-2", title: "promote approved", ops: { ledger: "gate", op: "deploy-web", gate: "promote", at: "2026-10-23T09:00:00.000Z" } });
    expect(gate).toMatchObject({ evidence: { ops: { ledger: "gate", ref: "chant/lifecycle:_gates/deploy-web.jsonl", field: "timestamp" } } });
    expect(await cite({ ops: { ledger: "plan", digest: "sha256:nope" } })).toMatchObject({ error: { code: "work-evidence-ops-missing" } });
    expect(await cite({ ops: { ledger: "gate", op: "deploy-web", gate: "promote", at: "2026-01-01T00:00:00.000Z" } })).toMatchObject({ error: { code: "work-evidence-ops-missing" } });
    expect(await cite({ ops: { ledger: "deploy", env: "staging", runId: "r-ok" } })).toMatchObject({ error: { code: "work-evidence-ops-missing" } });
    expect((await w10()).valid).toBe(true);
  });
});
