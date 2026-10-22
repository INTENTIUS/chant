/**
 * #4295: `chant components pr-post` posts the plan's note and `chant/plan`
 * from a report the pull request's code wrote, so it reads it as data: the
 * pull request, head, environment and member are the caller's, a report that
 * names others is refused, and the note carries no hidden marker but its own.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { postPlanReport, readPlanReport } from "./pr-post";
import { prNoteMarker, type PrReport } from "./pr-loop";
import type { ForgeStatus, PrForge } from "./pr-forge";

const FIXTURE = join(import.meta.dirname, "__fixtures__", "pr-loop", "pr-plan.golden.json");
const REPORT = JSON.parse(readFileSync(FIXTURE, "utf-8")) as PrReport;
const HEAD = REPORT.head;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function reportDir(report: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-pr-post-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  if (report !== undefined) writeFileSync(join(dir, "pr-plan.json"), typeof report === "string" ? report : JSON.stringify(report));
  return dir;
}

function fakeForge(refuse = false): { forge: PrForge; statuses: Array<{ sha: string; status: ForgeStatus }>; notes: Array<{ pr: number; marker: string; body: string }> } {
  const statuses: Array<{ sha: string; status: ForgeStatus }> = [];
  const notes: Array<{ pr: number; marker: string; body: string }> = [];
  const forge = {
    kind: "github",
    host: "github.com",
    runUrl: "https://github.com/acme/estate/actions/runs/1",
    async setStatus(sha: string, status: ForgeStatus) {
      if (refuse) throw new Error("403");
      statuses.push({ sha, status });
    },
    async upsertNote(pr: number, marker: string, body: string) {
      if (refuse) throw new Error("403");
      notes.push({ pr, marker, body });
      return "1";
    },
  } as unknown as PrForge;
  return { forge, statuses, notes };
}

const at = { pr: REPORT.pr!, head: HEAD, env: REPORT.env };

describe("pr-post reads the plan report as data (#4295)", () => {
  test("a report for this pull request, head and environment posts its status and its note", async () => {
    const { forge, statuses, notes } = fakeForge();
    const r = await postPlanReport({ forge, dir: reportDir(REPORT), ...at, result: "success" });
    expect(r).toMatchObject({ state: "success", noted: true, warnings: [] });
    expect(statuses).toEqual([{ sha: HEAD, status: expect.objectContaining({ context: "chant/plan", state: "success", url: "https://github.com/acme/estate/actions/runs/1" }) }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.marker).toBe(prNoteMarker("prod"));
    expect(notes[0]!.body.startsWith(prNoteMarker("prod") + "\n")).toBe(true);
  });

  test("a marker the change wrote into its report is defused, so the note claims no other environment's", async () => {
    const forged = { ...REPORT, message: `planned ${prNoteMarker("staging")} <!-- chant-pr:prod -->` };
    const { forge, notes } = fakeForge();
    await postPlanReport({ forge, dir: reportDir(forged), ...at });
    const body = notes[0]!.body;
    expect(body.split("<!--")).toHaveLength(2);
    expect(body).toContain("&lt;!-- chant-pr:staging -->");
  });

  test.each([
    ["another pull request", { pr: 13 }, /pull request 13, not 12/],
    ["another head", { head: "3".repeat(40) }, /for head/],
    ["another environment", { env: "staging" }, /environment "staging"/],
    ["a member", { member: "net" }, /member "net"/],
    ["the apply stage", { stage: "apply" }, /not a plan report/],
  ])("a report for %s is refused: a failed status and no note", async (_what, change, why) => {
    const { forge, statuses, notes } = fakeForge();
    const r = await postPlanReport({ forge, dir: reportDir({ ...REPORT, ...change }), ...at });
    expect(r.refused).toMatch(why);
    expect(r.state).toBe("failure");
    expect(statuses[0]!.sha).toBe(HEAD);
    expect(statuses[0]!.status.state).toBe("failure");
    expect(notes).toEqual([]);
  });

  test("no report, or one that does not read, fails the status", async () => {
    for (const report of [undefined, "{not json", "[]", JSON.stringify({ ...REPORT, members: "x" })]) {
      const { forge, statuses, notes } = fakeForge();
      const r = await postPlanReport({ forge, dir: reportDir(report), ...at });
      expect(r.state).toBe("failure");
      expect(statuses[0]!.status.state).toBe("failure");
      expect(notes).toEqual([]);
    }
    expect(readPlanReport({ dir: reportDir(undefined), ...at })).toEqual({ refused: "the plan job wrote no report" });
  });

  test("a plan job that failed fails the status, whatever its report says", async () => {
    const { forge, statuses } = fakeForge();
    const r = await postPlanReport({ forge, dir: reportDir(REPORT), ...at, result: "failure" });
    expect(r.state).toBe("failure");
    expect(statuses[0]!.status.description).toMatch(/^the plan job failed; /);
    expect(statuses[0]!.status.description.length).toBeLessThanOrEqual(140);
  });

  test("a member's report posts under the member's context and marker, and none when the change does not reach it", async () => {
    const { forge, statuses, notes } = fakeForge();
    await postPlanReport({ forge, dir: reportDir({ ...REPORT, member: "net" }), ...at, member: "net" });
    expect(statuses[0]!.status.context).toBe("chant/plan/net");
    expect(notes[0]!.marker).toBe(prNoteMarker("prod", "net"));
    const quiet = fakeForge();
    await postPlanReport({ forge: quiet.forge, dir: reportDir({ ...REPORT, member: "net", status: "nothing" }), ...at, member: "net" });
    expect(quiet.statuses).toHaveLength(1);
    expect(quiet.notes).toEqual([]);
  });

  test("a forge that refuses is a warning", async () => {
    const { forge } = fakeForge(true);
    const r = await postPlanReport({ forge, dir: reportDir(REPORT), ...at });
    expect(r.warnings).toEqual([expect.stringMatching(/could not set the chant\/plan status: 403/), expect.stringMatching(/could not post the note on #12: 403/)]);
    expect(r.noted).toBe(false);
  });
});
