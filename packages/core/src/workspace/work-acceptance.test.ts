/**
 * Acceptance criteria on work records (#2772), on a workspace built from the
 * reference workspace's decision and work kinds in a throwaway git repository.
 *
 * - W-001 is done, and passing evidence of each criterion's verification
 *   meets both of them, the manual one by bob while alice owns the item: met.
 * - W-002 is done, and its only evidence is a unit test for an e2e
 *   criterion: unmet.
 * - W-003 is done, and its manual criterion's verdict is by alice, its owner:
 *   the verdict does not count, so it is unmet as well.
 * - W-004 is done and lists no criteria: a legacy item, read as before.
 * - W-005 is in progress. A steward's Op attaches evidence to it under its
 *   work lease, and is refused on the manual criterion.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, REPO, repo } from "./__fixtures__/contract-repo";
import { runDeclarationChecks } from "./checks";
import { listWorkspaceWithKinds } from "./ls";
import lsSchema from "./ls.schema.json";
import { queryRecords } from "./records-cli";
import recordsSchema from "./records.schema.json";
import { workspaceStatus } from "./status";
import statusSchema from "./status.schema.json";
import { attachWorkEvidence } from "./work-evidence";
import workEvidenceSchema from "./work-evidence.schema.json";
import { workEvidence } from "../op/builders";
import { workEvidence as workEvidenceActivity } from "../op/activities";
import { ACTIVITY_PROFILES } from "../op/activity-profiles";
import { OpRunFailure, runOpLocally, type OpRunResult } from "../op/local-executor";
import type { ActivityFn } from "../op/activity-registry";
import type { OpConfig } from "../op/types";
import { declareSteward } from "../op/steward";
import { claimWorkLease, releaseWorkLease } from "../lifecycle/work-lease";

const REF = join(REPO, "reference-workspace");
const ref = (path: string) => readFileSync(join(REF, path), "utf-8");

function work(id: string, fields: Record<string, unknown>): string {
  const data = {
    schema: 1,
    id,
    title: `Work ${id}`,
    state: "done",
    implements: [],
    needs: [],
    constrains: ["member:app"],
    evidence: [],
    owner: "alice",
    opened_on: "2026-09-25",
    closed_on: "2026-09-25",
    source: { kind: "workspace", member: "app" },
    supersedes: [],
    ...fields,
  };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

const link = (criterion: string, verification: string, result: string, extra: Record<string, unknown> = {}) => ({
  title: `${criterion} ${verification}`,
  url: `https://example.com/${criterion}`,
  criterion,
  verification,
  result,
  ...extra,
});

const KIND = "work/work.kind.mjs";
let root: string;

beforeAll(() => {
  root = repo({
    "chant.workspace.json": JSON.stringify(
      {
        name: "studio",
        schema: 1,
        members: [{ name: "app", dir: "app", kind: "other", because: "a plain Node server" }],
        records: [{ kind: "decisions/decision.kind.mjs" }, { kind: KIND }],
      },
      null,
      2,
    ),
    "app/server.mjs": "export const port = 8080;\n",
    "decisions/decision.kind.mjs": ref("decisions/decision.kind.mjs"),
    "decisions/decision.schema.json": ref("decisions/decision.schema.json"),
    "decisions/ref-001-how-the-app-is-deployed.md": ref("decisions/ref-001-how-the-app-is-deployed.md"),
    [KIND]: ref(KIND),
    "work/work.schema.json": ref("work/work.schema.json"),
    "work/W-001-met.md": work("W-001", {
      acceptance: [
        { id: "AC-1", text: "The server answers on its port", verification: "unit" },
        { id: "AC-2", text: "A designer finds the page matches the spec", verification: "manual" },
      ],
      evidence: [link("AC-1", "unit", "fail"), link("AC-1", "unit", "pass"), link("AC-2", "manual", "pass", { by: "bob" })],
    }),
    "work/W-002-unmet.md": work("W-002", {
      acceptance: [{ id: "AC-1", text: "The page loads in a browser", verification: "e2e" }],
      evidence: [link("AC-1", "unit", "pass")],
    }),
    "work/W-003-self.md": work("W-003", {
      acceptance: [{ id: "AC-1", text: "Someone else signs off", verification: "manual" }],
      evidence: [link("AC-1", "manual", "pass", { by: "Alice" })],
    }),
    "work/W-004-legacy.md": work("W-004", { evidence: [{ title: "The review", url: "https://example.com/review" }] }),
    "work/W-005-leased.md": work("W-005", {
      state: "in-progress",
      closed_on: null,
      acceptance: [
        { id: "AC-1", text: "The server's test passes", verification: "unit" },
        { id: "AC-2", text: "A person tries it", verification: "manual" },
      ],
    }),
  });
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "the work");
});
afterAll(cleanScratch);

const records = contract(recordsSchema);

async function read() {
  const doc = await queryRecords({ kind: join(root, KIND), cwd: root, workGaps: false });
  records.expectValid(doc);
  if ("error" in doc || !("records" in doc)) throw new Error(JSON.stringify(doc));
  return doc.records;
}

const codes = (r: { warnings: { code: string }[] }) => r.warnings.map((w) => w.code);

describe("acceptance criteria on read (#2772)", () => {
  test("met: each criterion has passing evidence of its verification, and the manual verdict is someone else's", async () => {
    const w1 = (await read()).find((r) => r.id === "W-001")!;
    expect(w1.valid).toBe(true);
    expect(w1.acceptance).toEqual({
      met: 2,
      total: 2,
      criteria: [
        { id: "AC-1", verification: "unit", met: true },
        { id: "AC-2", verification: "manual", met: true },
      ],
    });
    expect(codes(w1)).toEqual([]);
  });

  test("unmet: evidence of another verification does not count, and the done item is warned", async () => {
    const w2 = (await read()).find((r) => r.id === "W-002")!;
    expect(w2.acceptance).toMatchObject({ met: 0, total: 1 });
    expect(codes(w2)).toEqual(["work-acceptance-unmet"]);
    expect(w2.warnings[0].message).toMatch(/AC-1 \(e2e\)/);
  });

  test("manual by the implementer: the verdict is refused, warned, and the criterion stays unmet", async () => {
    const w3 = (await read()).find((r) => r.id === "W-003")!;
    expect(w3.acceptance).toMatchObject({ met: 0, total: 1 });
    expect(codes(w3)).toEqual(["work-acceptance-self-verified", "work-acceptance-unmet"]);
  });

  test("a legacy item without criteria is valid, reads acceptance null and gets no acceptance warning", async () => {
    const w4 = (await read()).find((r) => r.id === "W-004")!;
    expect(w4.valid).toBe(true);
    expect(w4.acceptance).toBeNull();
    expect(codes(w4)).toEqual([]);
  });

  test("an open item with criteria unmet is not warned: only done needs them met", async () => {
    const w5 = (await read()).find((r) => r.id === "W-005")!;
    expect(w5.acceptance).toMatchObject({ met: 0, total: 2 });
    expect(codes(w5)).toEqual([]);
  });

  test("check fails with WSP117 and the reason code on each done item with a criterion unmet", async () => {
    const report = await runDeclarationChecks(root);
    const wsp117 = report.diagnostics.filter((d) => d.ruleId === "WSP117");
    expect(wsp117.map((d) => [d.file, d.code, d.severity])).toEqual([
      ["work/W-002-unmet.md", "work-acceptance-unmet", "error"],
      ["work/W-003-self.md", "work-acceptance-unmet", "error"],
    ]);
    expect(report.ok).toBe(false);
  });

  test("ls --json and status --json count each item's criteria, met of total, in the read contract", async () => {
    const ls = await listWorkspaceWithKinds({ cwd: root });
    contract(lsSchema).expectValid(ls);
    if ("error" in ls) throw new Error(ls.error.message);
    const kinds = Object.fromEntries(ls.workspace.records.map((r) => [r.path, r.acceptance]));
    expect(kinds["decisions/decision.kind.mjs"]).toBeNull();
    expect(kinds[KIND]).toEqual([
      { item: "W-001", state: "done", met: 2, total: 2 },
      { item: "W-002", state: "done", met: 0, total: 1 },
      { item: "W-003", state: "done", met: 0, total: 1 },
      { item: "W-005", state: "in-progress", met: 0, total: 2 },
    ]);

    const status = await workspaceStatus({ cwd: root, env: "dev" });
    contract(statusSchema).expectValid(status);
    if ("error" in status) throw new Error(status.error.message);
    expect(status.acceptance.map((a) => [a.member, a.kind, a.item, `${a.met}/${a.total}`])).toEqual([
      [null, KIND, "W-001", "2/2"],
      [null, KIND, "W-002", "0/1"],
      [null, KIND, "W-003", "0/1"],
      [null, KIND, "W-005", "0/2"],
    ]);
  });
});

describe("a steward Op under workLease attaches evidence to a criterion (#2772)", () => {
  const evidenceDoc = contract(workEvidenceSchema);

  async function run(config: OpConfig, holder: string): Promise<OpRunResult> {
    const activities = new Map<string, ActivityFn>([["workEvidence", workEvidenceActivity as unknown as ActivityFn]]);
    try {
      return await runOpLocally(config, activities, ACTIVITY_PROFILES, undefined, { cwd: root, ledger: { cwd: root }, work: { holder } });
    } catch (err) {
      if (err instanceof OpRunFailure) return err.result;
      throw err;
    }
  }

  const op = (step: ReturnType<typeof workEvidence>): OpConfig => ({
    name: "verify",
    overview: "attach the test run to its criterion",
    workLease: { item: "W-005", kind: KIND },
    phases: [{ name: "Verify", steps: [step] }],
  });

  test("the run holding the lease appends passing evidence, and the criterion is met", async () => {
    const config = op(workEvidence("AC-1", { result: "pass", title: "the server test", url: "https://example.com/ci/1", cwd: root }));
    expect(declareSteward({ name: "box", ops: [config] }).ops).toHaveLength(1);
    const result = await run(config, "box/verify@h1");
    expect(result.status).toBe("ok");
    expect(result.workLease).toMatchObject({ item: "W-005", released: true });
    const w5 = (await read()).find((r) => r.id === "W-005")!;
    expect(w5.acceptance).toMatchObject({ met: 1, total: 2 });
    expect(w5.data!.evidence).toEqual([
      expect.objectContaining({ url: "https://example.com/ci/1", criterion: "AC-1", verification: "unit", result: "pass", by: "box/verify@h1" }),
    ]);
  });

  test("a manual criterion is refused: the run holding the lease is the implementer", async () => {
    const result = await run(op(workEvidence("AC-2", { result: "pass", title: "tried it", url: "https://example.com/tried", cwd: root })), "box/verify@h2");
    expect(result.status).toBe("fail");
    expect(JSON.stringify(result.records)).toMatch(/work-acceptance-self-verified/);
    expect((await read()).find((r) => r.id === "W-005")!.acceptance).toMatchObject({ met: 1, total: 2 });
  });

  test("without the live lease, or with another token or criterion, nothing is written", async () => {
    const ask = (over: Partial<Parameters<typeof attachWorkEvidence>[0]>) =>
      attachWorkEvidence({ cwd: root, item: "W-005", holder: "me", token: "t", criterion: "AC-1", result: "pass", title: "x", url: "https://example.com/x", ...over });
    const unleased = await ask({});
    evidenceDoc.expectValid(unleased);
    expect("error" in unleased && unleased.error.code).toBe("lease-not-held");

    const claimed = await claimWorkLease("W-005", "me", { cwd: join(root, "work") });
    if (!claimed.ok) throw new Error(claimed.message);
    try {
      expect(await ask({ token: "other" })).toMatchObject({ error: { code: "lease-token-mismatch" } });
      expect(await ask({ holder: "you", token: claimed.lease.token })).toMatchObject({ error: { code: "lease-held" } });
      expect(await ask({ token: claimed.lease.token, criterion: "AC-9" })).toMatchObject({ error: { code: "work-criterion-unknown" } });
      const ok = await ask({ token: claimed.lease.token, result: "fail" });
      evidenceDoc.expectValid(ok);
      expect(ok).toMatchObject({ item: "W-005", kind: KIND, path: "work/W-005-leased.md", acceptance: { met: 1, total: 2 } });
    } finally {
      await releaseWorkLease("W-005", "me", { cwd: join(root, "work"), token: claimed.lease.token });
    }
    expect(await attachWorkEvidence({ cwd: root, item: "W-004", holder: "me", token: "t", criterion: "AC-1", result: "pass", title: "x", url: "https://example.com/x" })).toMatchObject({
      error: { code: "work-item-closed" },
    });
  });
});
