/**
 * #4295: `chant components pr-post` posts the plan's note and `chant/plan`
 * from a report the pull request's code wrote, so it reads it as data: the
 * pull request, head, environment and member are the caller's, a report that
 * names others is refused, and the note carries no hidden marker but its own.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { CommandContext } from "./cli/registry";
import { parseArgs } from "./cli/parse-args";
import { postOpenPlanReports, postPlanReport, readPlanReport } from "./pr-post";
import { prNoteMarker, prStatusState, type PrReport } from "./pr-loop";
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

describe("pr-post asks for overdue scheduled Ops itself (#4289, #4295)", () => {
  test("the Ops it finds go in the note, and an overdue list the change wrote is dropped", async () => {
    const forged = { ...REPORT, overdue: [{ op: "forged", cron: "* * * * *", message: "forged warning" }] };
    const found = { op: "drift-watch", cron: "0 * * * *", message: "Op drift-watch has not run since its cron fired twice" };
    const { forge, notes } = fakeForge();
    await postPlanReport({ forge, dir: reportDir(forged), ...at, overdue: async () => [found as never] });
    expect(notes[0]!.body).toContain("drift-watch has not run");
    expect(notes[0]!.body).not.toContain("forged warning");
    const quiet = fakeForge();
    await postPlanReport({ forge: quiet.forge, dir: reportDir(forged), ...at, overdue: async () => [] });
    expect(quiet.notes[0]!.body).not.toContain("forged warning");
  });
});

describe("pr-post --open posts each open merge request's plan from a pipeline of the target branch (#4328)", () => {
  const JOB_URL = (id: number) => `https://gitlab.com/acme/estate/-/jobs/${id}`;
  const OTHER = "c".repeat(40);

  /** A GitLab client with the merge requests' plan jobs, their artifacts and the statuses already posted. */
  function gitlab(input: { jobs: Array<{ pr: number; head: string; id: number; status: string }>; artifacts: Record<number, string>; posted?: Record<string, string> }) {
    const statuses: Array<{ sha: string; status: ForgeStatus; url?: string }> = [];
    const notes: Array<{ pr: number; body: string }> = [];
    const asked: Array<[string, string]> = [];
    const reads: string[] = [];
    let overdue = 0;
    const forge = {
      kind: "gitlab",
      host: "gitlab.com",
      async mergeRequestJobs(branch: string, job: string) {
        asked.push([branch, job]);
        return input.jobs.map((j) => ({ ...j, url: JOB_URL(j.id) }));
      },
      async jobArtifact(id: number, path: string) {
        reads.push(`${id}:${path}`);
        return input.artifacts[id];
      },
      async statusUrl(sha: string) {
        return input.posted?.[sha];
      },
      async setStatus(this: PrForge, sha: string, status: ForgeStatus) {
        statuses.push({ sha, status, ...(this.runUrl ? { url: this.runUrl } : {}) });
      },
      async upsertNote(pr: number, _marker: string, body: string) {
        notes.push({ pr, body });
        return "1";
      },
    } as unknown as PrForge;
    const count = async () => {
      overdue++;
      return [{ op: "drift", cron: "0 * * * *", since: "2025-10-01T00:00:00Z", message: "Op `drift` is overdue" }];
    };
    return { forge, statuses, notes, asked, reads, overdue: count, overdueCalls: () => overdue };
  }

  test("a settled plan job's report is read from its artifacts and posted, linking the job; a running one waits", async () => {
    const g = gitlab({
      jobs: [
        { pr: REPORT.pr, head: HEAD, id: 101, status: "success" },
        { pr: 8, head: OTHER, id: 102, status: "running" },
      ],
      artifacts: { 101: JSON.stringify(REPORT) },
    });
    const { posts, warnings } = await postOpenPlanReports({ forge: g.forge, branch: "main", job: "plan", artifactDir: ".chant/pr/", env: REPORT.env, overdue: g.overdue });
    expect(warnings).toEqual([]);
    expect(g.asked).toEqual([["main", "plan"]]);
    expect(g.reads).toEqual(["101:.chant/pr/pr-plan.json"]);
    expect(posts.map((p) => [p.pr, p.skipped ?? p.posted!.state])).toEqual([[REPORT.pr, prStatusState(REPORT)], [8, "the plan job is running"]]);
    expect(g.statuses).toEqual([{ sha: HEAD, status: expect.objectContaining({ context: "chant/plan", state: prStatusState(REPORT), url: JOB_URL(101) }), url: JOB_URL(101) }]);
    expect(g.notes.map((n) => n.pr)).toEqual([REPORT.pr]);
    expect(g.notes[0]!.body).toContain("Op `drift` is overdue");
  });

  test("a job whose result is already posted is not posted again", async () => {
    const g = gitlab({ jobs: [{ pr: REPORT.pr, head: HEAD, id: 101, status: "success" }], artifacts: { 101: JSON.stringify(REPORT) }, posted: { [HEAD]: JOB_URL(101) } });
    const { posts } = await postOpenPlanReports({ forge: g.forge, branch: "main", job: "plan", artifactDir: ".chant/pr", env: REPORT.env });
    expect(posts).toEqual([{ pr: REPORT.pr, head: HEAD, skipped: "this plan job's result is already posted" }]);
    expect(g.statuses).toEqual([]);
  });

  test("the pull request and head are GitLab's: a report for another head, a missing one and a failed job each fail the status", async () => {
    const g = gitlab({
      jobs: [
        { pr: REPORT.pr, head: OTHER, id: 101, status: "success" },
        { pr: 8, head: HEAD, id: 102, status: "failed" },
        { pr: 9, head: HEAD, id: 103, status: "failed" },
      ],
      artifacts: { 101: JSON.stringify(REPORT), 103: JSON.stringify({ ...REPORT, pr: 9 }) },
    });
    const { posts } = await postOpenPlanReports({ forge: g.forge, branch: "main", job: "plan", artifactDir: ".chant/pr", env: REPORT.env, overdue: g.overdue });
    expect(posts.map((p) => [p.pr, p.posted!.state, p.posted!.refused ?? ""])).toEqual([
      [REPORT.pr, "failure", expect.stringMatching(/the report is for head/)],
      [8, "failure", "the plan job wrote no report"],
      [9, "failure", ""],
    ]);
    expect(g.notes.map((n) => n.pr)).toEqual([9]);
    // The check runs once, however many merge requests it posts for.
    expect(g.overdueCalls()).toBe(1);
  });

  test("a forge that cannot list merge request jobs is refused", async () => {
    await expect(postOpenPlanReports({ forge: fakeForge().forge, branch: "main", job: "plan", artifactDir: ".chant/pr", env: REPORT.env })).rejects.toThrow(/it is for GitLab/);
  });
});

describe("chant components pr-post --open refuses what it cannot post for (#4328)", () => {
  const run = async (args: Record<string, unknown>): Promise<number> => {
    const { runComponentsPrPost } = await import("./cli/handlers/pr");
    return runComponentsPrPost({ args } as unknown as CommandContext);
  };

  test("--pr or --head, a forge other than GitLab, and no branch are each refused", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
    try {
      expect(await run({ open: true, pr: 7, env: "prod", forge: "gitlab" })).toBe(1);
      expect(await run({ open: true, env: "prod", forge: "github" })).toBe(1);
      const branch = process.env.CI_COMMIT_BRANCH;
      delete process.env.CI_COMMIT_BRANCH;
      try {
        expect(await run({ open: true, env: "prod", forge: "gitlab" })).toBe(1);
      } finally {
        if (branch !== undefined) process.env.CI_COMMIT_BRANCH = branch;
      }
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("\n")).toMatch(/takes no --pr or --head/);
    expect(errors.join("\n")).toMatch(/--forge gitlab/);
    expect(errors.join("\n")).toMatch(/pass --branch <branch>/);
  });

  test("the flags parse", () => {
    expect(parseArgs(["components", "pr-post", "--open", "--env", "prod", "--forge", "gitlab", "--branch", "main"])).toMatchObject({ open: true, env: "prod", forge: "gitlab", branch: "main" });
  });
});
