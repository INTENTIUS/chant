import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LiveRun, inFlightPaths, liveRunEnv, readInFlightRun, reportRunActivity, withLiveRun, RUN_ACTIVITY_ENV } from "./run-live";
import { runOpLocally } from "./local-executor";
import { readRunLedger } from "../lifecycle/run-ledger";
import type { OpConfig } from "./types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function checkout(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "run-live-")));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

describe("the in-flight run record", () => {
  test("is kept under the git directory and read back with the newest activity lines", async () => {
    const dir = checkout();
    const live = (await LiveRun.open({ cwd: dir, env: "local", op: "build", id: "r1", started: "2026-09-27T10:00:00.000Z", steward: "s" }))!;
    expect(live.activityFile.startsWith(join(dir, ".git", "chant", "runs"))).toBe(true);
    live.phaseStarted("Pick");
    live.phaseEnded("Pick", "ok", 12);
    live.phaseStarted("Build");
    const done = live.stepStarted("shellCmd", "build");
    live.item("W-1");
    for (let i = 1; i <= 25; i++) appendFileSync(live.activityFile, `line ${i}\n`);

    const run = (await readInFlightRun(dir, "local", "build"))!;
    expect(run).toMatchObject({
      id: "r1",
      steward: "s",
      item: "W-1",
      phase: { name: "Build" },
      step: { name: "build", fn: "shellCmd" },
      phases: [{ name: "Pick", status: "ok", durationMs: 12 }],
    });
    expect(run.activity.total).toBe(25);
    expect(run.activity.lines).toHaveLength(20);
    expect(run.activity.lines[0]).toEqual({ seq: 6, at: null, text: "line 6" });

    done();
    expect((await readInFlightRun(dir, "local", "build"))!.step).toBeNull();
    live.close();
    expect(await readInFlightRun(dir, "local", "build")).toBeNull();
  });

  test("a record left by a process that is gone is not in flight", async () => {
    const dir = checkout();
    const paths = (await inFlightPaths(dir, "local", "build"))!;
    const live = (await LiveRun.open({ cwd: dir, env: "local", op: "build", id: "r1", started: "2026-09-27T10:00:00.000Z" }))!;
    const rec = JSON.parse(readFileSync(paths.record, "utf8"));
    writeFileSync(paths.record, JSON.stringify({ ...rec, pid: 2 ** 22 + 12345 }));
    expect(await readInFlightRun(dir, "local", "build")).toBeNull();
    live.close();
  });

  test("outside a checkout there is none, and a report is a no-op", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "run-live-none-")));
    dirs.push(dir);
    expect(await LiveRun.open({ cwd: dir, env: "local", op: "x", id: "r", started: "now" })).toBeUndefined();
    expect(liveRunEnv()).toEqual({});
    expect(() => reportRunActivity("nothing")).not.toThrow();
  });

  test("a run hands its steps the activity file, and removes it once its ledger record is written", async () => {
    const dir = checkout();
    let seen: Record<string, string> = {};
    let during: Awaited<ReturnType<typeof readInFlightRun>> = null;
    const op = {
      name: "build",
      overview: "build",
      phases: [
        {
          name: "Build",
          steps: [{ kind: "activity", fn: "work", id: "build", args: {} }],
        },
      ],
    } as unknown as OpConfig;
    const activities = new Map([
      [
        "work",
        async () => {
          seen = liveRunEnv();
          reportRunActivity("Edit  kit/lobby/box-side.mjs\n");
          during = await readInFlightRun(dir, "local", "build");
          return {};
        },
      ],
    ]);
    const result = await runOpLocally(op, activities as never, {}, undefined, { runId: "r2", ledger: { cwd: dir }, cwd: dir });
    expect(result.status).toBe("ok");
    expect(seen[RUN_ACTIVITY_ENV]).toMatch(/local__build\.activity\.jsonl$/);
    expect(during).toMatchObject({ id: "r2", phase: { name: "Build" }, step: { name: "build" } });
    expect(during!.activity.lines.map((l) => l.text)).toEqual(["Edit kit/lobby/box-side.mjs"]);
    expect(existsSync(seen[RUN_ACTIVITY_ENV])).toBe(false);
    const { records } = await readRunLedger("local", "build", { cwd: dir });
    expect(records.at(-1)!.phases[0]).toMatchObject({ name: "Build", status: "ok", durationMs: expect.any(Number) });
  });

  test("withLiveRun without a run just calls through", async () => {
    expect(await withLiveRun(undefined, async () => liveRunEnv())).toEqual({});
  });
});
