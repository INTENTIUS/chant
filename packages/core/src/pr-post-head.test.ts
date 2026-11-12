/**
 * #5020: on GitHub the note job names the pull request's head
 * (`github.event.pull_request.head.sha`), while the plan job checked out
 * the run's merge preview (`github.sha`). `pr-post --head <head>` takes a
 * report, a plan note hand-off or a run record for that merge preview as the
 * head's, and for the head itself (terragucci's plan verb writes its
 * hand-off for the head), and posts the status on the head.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { PLAN_RECORD_JS, PLAN_RUN_RECORD_ENV } from "./components/product-plan";
import { plannedForHead } from "./pr-forge-job";
import type { ForgeStatus, PrForge } from "./pr-forge";
import type { PrReport } from "./pr-loop";
import { planBodyHandoff, PR_PLAN_NOTE_FILE } from "./pr-plan-note";
import { PLAN_RUN_RECORD_FILE, readPlanRunRecord } from "./pr-plan-record";
import { postPlanReport, readPlanNoteHandoff } from "./pr-post";

const REPORT = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "pr-loop", "pr-plan.golden.json"), "utf-8")) as PrReport;
const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const OTHER = "c".repeat(40);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "chant-5020-"));
  dirs.push(d);
  return d;
};

function eventEnv(event = "pull_request"): Record<string, string> {
  const path = join(tmp(), "event.json");
  writeFileSync(path, JSON.stringify({ number: 12, pull_request: { number: 12, head: { sha: HEAD } } }));
  return { GITHUB_EVENT_NAME: event, GITHUB_SHA: MERGE, GITHUB_EVENT_PATH: path };
}

function fakeForge(): { forge: PrForge; statuses: string[] } {
  const statuses: string[] = [];
  const forge = {
    kind: "github",
    host: "github.com",
    async setStatus(sha: string, _status: ForgeStatus) {
      statuses.push(sha);
    },
    async upsertNote() {
      return "1";
    },
  } as unknown as PrForge;
  return { forge, statuses };
}

describe("the commit a pull_request run's plan job planned for the head (#5020)", () => {
  test("the merge preview, when --head is the event's head", () => {
    expect(plannedForHead(HEAD, eventEnv())).toBe(MERGE);
  });

  test("nothing for another head, another event, a run of the head itself, or no event", () => {
    expect(plannedForHead(OTHER, eventEnv())).toBeUndefined();
    expect(plannedForHead(HEAD, eventEnv("push"))).toBeUndefined();
    expect(plannedForHead(HEAD, { ...eventEnv(), GITHUB_SHA: HEAD })).toBeUndefined();
    expect(plannedForHead(HEAD, { GITHUB_SHA: MERGE })).toBeUndefined();
  });
});

describe("pr-post for the head takes the merge preview's report as the head's (#5020)", () => {
  const at = { pr: REPORT.pr!, head: HEAD, planned: MERGE, env: REPORT.env };
  const reportDir = (head: string): string => {
    const d = tmp();
    writeFileSync(join(d, "pr-plan.json"), JSON.stringify({ ...REPORT, head }));
    return d;
  };

  test.each([
    ["the merge preview the plan job checked out", MERGE],
    ["the head", HEAD],
  ])("a report for %s posts on the head", async (_what, head) => {
    const { forge, statuses } = fakeForge();
    const r = await postPlanReport({ forge, dir: reportDir(head), ...at, result: "success" });
    expect(r.refused).toBeUndefined();
    expect(r.state).toBe("success");
    expect(statuses).toEqual([HEAD]);
  });

  test("a report for another commit is refused, and so is the merge preview's when nothing says the plan job checked it out", async () => {
    const other = await postPlanReport({ forge: fakeForge().forge, dir: reportDir(OTHER), ...at });
    expect(other.refused).toMatch(/the report is for head/);
    const { planned: _planned, ...bare } = at;
    const merge = await postPlanReport({ forge: fakeForge().forge, dir: reportDir(MERGE), ...bare });
    expect(merge.refused).toMatch(/the report is for head/);
  });

  test("a product's plan note hand-off for the merge preview or the head is the head's", () => {
    for (const head of [MERGE, HEAD]) {
      const d = tmp();
      writeFileSync(join(d, PR_PLAN_NOTE_FILE), JSON.stringify(planBodyHandoff("planned", { pr: 12, head, env: "prod", state: "success", description: "planned" })));
      expect(readPlanNoteHandoff({ dir: d, pr: 12, head: HEAD, planned: MERGE, env: "prod" })).toHaveProperty("handoff");
      if (head === MERGE) expect(readPlanNoteHandoff({ dir: d, pr: 12, head: HEAD, env: "prod" })).toEqual({ refused: expect.stringMatching(/for head/) });
    }
  });

  test("the plan job's run record of the merge preview is the head's", () => {
    const d = tmp();
    const config = JSON.stringify({ op: "pr-plan", env: "prod", labels: { Env: "prod", Pipeline: "pr", Job: "plan" } });
    execFileSync(process.execPath, ["-e", PLAN_RECORD_JS, d], { cwd: d, env: { ...process.env, [PLAN_RUN_RECORD_ENV]: config, CHANT_PLAN_EXIT: "0", CHANT_PLAN_STARTED: "2026-11-10T00:00:00Z" } });
    const file = join(d, PLAN_RUN_RECORD_FILE);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf-8")), gitSha: MERGE }));
    expect(readPlanRunRecord(d, { env: "prod", head: HEAD, planned: MERGE })).toHaveProperty("record");
    expect(readPlanRunRecord(d, { env: "prod", head: HEAD })).toEqual({ refused: expect.stringMatching(/for commit/) });
  });
});
