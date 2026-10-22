/**
 * Scheduled watch and reconcile Ops that stopped running (#4289): the UTC
 * cron count, the verdict, the forge clients' `scheduledRuns`, the check the
 * plan job runs, and the warning line in the plan note.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cronFiresUtc } from "./cron";
import { checkOverdueOps, opPipelineFile, overdueVerdict, scheduledWatches } from "./schedule-overdue";
import { forgejoForge, githubForge, gitlabForge, type ForgeFetch, type PrForge } from "../pr-forge";
import { renderPrNote, type PrReport } from "../pr-loop";
import type { OpConfig } from "./types";

function fakeFetch(route: (method: string, url: URL) => unknown): ForgeFetch {
  return async (url, init) => {
    const found = route(init.method, new URL(url));
    if (found === undefined) return { ok: false, status: 404, text: async () => '{"message":"Not Found"}' };
    if (typeof found === "number") return { ok: false, status: found, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify(found) };
  };
}

describe("cronFiresUtc", () => {
  test("counts fires in UTC, after the start and up to the end", () => {
    const fires = cronFiresUtc("0 6 * * *", new Date("2026-10-01T06:00:00Z"), new Date("2026-10-04T05:59:00Z"), 5);
    expect(fires.map((d) => d.toISOString())).toEqual(["2026-10-02T06:00:00.000Z", "2026-10-03T06:00:00.000Z"]);
  });

  test("stops at max, reads weekday names as numbers and 7 as Sunday", () => {
    expect(cronFiresUtc("*/15 * * * *", new Date("2026-10-01T00:00:00Z"), new Date("2026-10-02T00:00:00Z"), 2)).toHaveLength(2);
    const sundays = cronFiresUtc("0 0 * * 7", new Date("2026-10-01T00:00:00Z"), new Date("2026-10-31T00:00:00Z"), 10);
    expect(sundays.every((d) => d.getUTCDay() === 0)).toBe(true);
    expect(sundays).toHaveLength(4);
  });

  test("an expression that is not 5 or 6 fields fires never", () => {
    expect(cronFiresUtc("0 6 *", new Date("2026-01-01T00:00:00Z"), new Date("2026-12-31T00:00:00Z"), 2)).toEqual([]);
  });
});

describe("scheduledWatches", () => {
  const op = (name: string, labels?: Record<string, string>, cron?: string): OpConfig =>
    ({ name, overview: "", phases: [], ...(labels ? { labels } : {}), ...(cron ? { schedule: { cron } } : {}) }) as OpConfig;

  test("keeps scheduled Ops labelled Watch or Reconcile, sorted", () => {
    const got = scheduledWatches([
      op("z-watch", { Watch: "true" }, "0 * * * *"),
      op("a-reconcile", { Reconcile: "true" }, "0 6 * * *"),
      op("unscheduled", { Watch: "true" }),
      op("deploy", undefined, "0 6 * * *"),
    ]);
    expect(got).toEqual([
      { op: "a-reconcile", cron: "0 6 * * *" },
      { op: "z-watch", cron: "0 * * * *" },
    ]);
  });
});

describe("overdueVerdict", () => {
  const watch = { op: "drift", cron: "0 6 * * *" };
  const now = new Date("2026-10-22T12:00:00Z");

  test("one missed fire is on time; two is overdue", () => {
    expect(overdueVerdict(watch, "github", { last: "2026-10-21T06:01:00Z" }, undefined, now)).toBeUndefined();
    const late = overdueVerdict(watch, "github", { last: "2026-10-20T06:01:00Z" }, undefined, now);
    expect(late?.since).toBe("2026-10-20T06:01:00Z");
    expect(late?.message).toContain("Op `drift` is overdue");
    expect(late?.message).toContain("its last run was on 2026-10-20");
  });

  test("a job that never ran counts from its pipeline file's commit", () => {
    const v = overdueVerdict(watch, "forgejo", {}, "2026-10-01T00:00:00Z", now);
    expect(v?.neverRan).toBe(true);
    expect(v?.message).toContain("no run is on record since its pipeline was added on 2026-10-01");
  });

  test("nothing to count from is no verdict", () => {
    expect(overdueVerdict(watch, "github", {}, undefined, now)).toBeUndefined();
  });

  test("names a disabled workflow and a missing GitLab schedule", () => {
    expect(overdueVerdict(watch, "github", { last: "2026-09-01T00:00:00Z", disabled: "disabled_inactivity" }, undefined, now)?.message).toContain("disabled_inactivity");
    expect(overdueVerdict(watch, "gitlab", { noSchedule: true }, "2026-09-01T00:00:00Z", now)?.message).toContain("No active pipeline schedule sets CHANT_SCHEDULED_OP to drift");
  });
});

describe("scheduledRuns", () => {
  test("github: the newest schedule or dispatch run, and a disabled workflow", async () => {
    const fetch = fakeFetch((_m, u) => {
      if (u.pathname === "/repos/acme/infra/actions/workflows/drift.yml") return { state: "disabled_inactivity" };
      if (u.pathname === "/repos/acme/infra/actions/workflows/drift.yml/runs") {
        return { workflow_runs: [{ created_at: u.searchParams.get("event") === "schedule" ? "2026-08-01T06:00:00Z" : "2026-08-03T10:00:00Z" }] };
      }
      return undefined;
    });
    const forge = githubForge({ apiBase: "https://api.github.com", repo: "acme/infra", token: "t", fetch });
    expect(await forge.scheduledRuns!({ op: "drift", workflow: "drift.yml" })).toEqual({ last: "2026-08-03T10:00:00Z", disabled: "disabled_inactivity" });
  });

  test("forgejo: only this workflow's schedule and dispatch runs", async () => {
    const fetch = fakeFetch((_m, u) =>
      u.pathname === "/api/v1/repos/acme/infra/actions/runs"
        ? {
            workflow_runs: [
              { event: "schedule", workflow_id: "other.yml", created: "2026-10-20T00:00:00Z" },
              { event: "push", workflow_id: "drift.yml", created: "2026-10-19T00:00:00Z" },
              { event: "schedule", workflow_id: "drift.yml", created: "2026-10-10T00:00:00Z" },
            ],
          }
        : undefined,
    );
    const forge = forgejoForge({ apiBase: "https://code.example/api/v1", repo: "acme/infra", host: "code.example", token: "t", fetch });
    expect(await forge.scheduledRuns!({ op: "drift", workflow: "drift.yml" })).toEqual({ last: "2026-10-10T00:00:00Z" });
  });

  test("gitlab: the schedules that select the Op, and none", async () => {
    const fetch = fakeFetch((_m, u) => {
      const p = u.pathname.replace("/api/v4/projects/42", "");
      if (p === "/pipeline_schedules") return [{ id: 1 }, { id: 2 }];
      if (p === "/pipeline_schedules/1") return { id: 1, variables: [{ key: "CHANT_SCHEDULED_OP", value: "drift" }], last_pipeline: { id: 900 } };
      if (p === "/pipeline_schedules/2") return { id: 2, variables: [{ key: "CHANT_SCHEDULED_OP", value: "other" }], last_pipeline: { id: 901 } };
      if (p === "/pipelines/900") return { id: 900, created_at: "2026-10-01T06:00:00Z" };
      return undefined;
    });
    const forge = gitlabForge({ apiBase: "https://gitlab.com/api/v4", project: "42", token: "t", fetch });
    expect(await forge.scheduledRuns!({ op: "drift", workflow: "ops.gitlab-ci.yml" })).toEqual({ last: "2026-10-01T06:00:00Z" });
    expect(await forge.scheduledRuns!({ op: "nobody", workflow: "ops.gitlab-ci.yml" })).toEqual({ noSchedule: true });
  });
});

describe("checkOverdueOps", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function repo(files: Record<string, string>, date: string): string {
    dir = mkdtempSync(join(tmpdir(), "chant-overdue-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir!, ...args], { env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }, stdio: "pipe" });
    git("init", "-q");
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "add");
    return dir;
  }

  const forgeWith = (kind: PrForge["kind"], scheduledRuns: PrForge["scheduledRuns"]): PrForge => ({ kind, host: "example", scheduledRuns }) as PrForge;

  test("warns for an Op whose job never ran since its workflow was added, and skips one with no pipeline file", async () => {
    const root = repo({ ".github/workflows/drift.yml": "on: schedule" }, "2026-10-01T00:00:00Z");
    const asked: string[] = [];
    const lines: string[] = [];
    const found = await checkOverdueOps({
      watches: [
        { op: "drift", cron: "0 6 * * *" },
        { op: "operator-only", cron: "0 6 * * *" },
      ],
      forge: forgeWith("github", async (q) => {
        asked.push(q.workflow);
        return {};
      }),
      repoRoot: root,
      now: new Date("2026-10-22T00:00:00Z"),
      log: (l) => lines.push(l),
    });
    expect(asked).toEqual(["drift.yml"]);
    expect(found.map((o) => [o.op, o.neverRan, o.since.slice(0, 10)])).toEqual([["drift", true, "2026-10-01"]]);
    expect(lines).toHaveLength(1);
  });

  test("a forge that will not answer is a log line and no verdict", async () => {
    const root = repo({ ".github/workflows/web-drift.yml": "on: schedule" }, "2026-10-01T00:00:00Z");
    const lines: string[] = [];
    const found = await checkOverdueOps({
      watches: [{ op: "drift", cron: "0 6 * * *" }],
      forge: forgeWith("github", async () => {
        throw new Error("GET answered 403");
      }),
      repoRoot: root,
      member: "web",
      now: new Date("2026-10-22T00:00:00Z"),
      log: (l) => lines.push(l),
    });
    expect(found).toEqual([]);
    expect(lines[0]).toContain("did not say when Op drift last ran");
  });

  test("gitlab: the root file whose rules select the Op", () => {
    const root = repo({ "ops.gitlab-ci.yml": 'rules:\n  - if: $CI_PIPELINE_SOURCE == "schedule" && $CHANT_SCHEDULED_OP == "drift"\n' }, "2026-10-01T00:00:00Z");
    expect(opPipelineFile(root, "gitlab", "drift")).toBe("ops.gitlab-ci.yml");
    expect(opPipelineFile(root, "gitlab", "other")).toBeUndefined();
  });
});

describe("the plan note", () => {
  test("prints each overdue Op as a warning", () => {
    const report = {
      stage: "plan",
      env: "prod",
      base: "b".repeat(40),
      head: "a".repeat(40),
      status: "nothing",
      digest: "",
      members: [],
      selection: { changed: [], dependents: [], unclaimed: [], indeterminate: [], waves: [] },
      changeSet: { members: [], entries: [], summary: { byMember: {} } },
      approval: { status: "pending" },
      overdue: [{ op: "drift", cron: "0 6 * * *", since: "2026-10-01T00:00:00Z", message: "Op `drift` is overdue: test." }],
    } as unknown as PrReport;
    expect(renderPrNote(report)).toContain("Warning: Op `drift` is overdue: test.");
  });
});
