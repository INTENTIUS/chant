/**
 * #4042: a run's events kept on this host, replayed, and followed while the
 * run is in progress. No servers: a temp git checkout, the real executor and
 * the real writer, and a short poll.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runOpLocally } from "./op/local-executor";
import { memoryGateLedgerPort } from "./op/gate";
import type { ActivityFn } from "./op/activity-registry";
import type { OpConfig } from "./op/types";
import type { RunEvent } from "./run-event";
import { openRunEventStream, runEventRunOf } from "./run-event-stream";
import { findStoredRun, listStoredRuns, openRunEventStore, readRunEvents, runEventsDir } from "./run-event-store";
import { checkRunEventLines } from "./workspace/__fixtures__/run-event-check";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function checkout(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "run-event-store-")));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

const op: OpConfig = {
  name: "deploy-api",
  overview: "",
  phases: [{ name: "Build", steps: [{ kind: "activity", fn: "make" }] }],
};
const ok: ActivityFn = async () => ({ done: true });
const PROFILES = { fastIdempotent: { timeout: "5m", retry: { maximumAttempts: 1 } } };

describe("a settled run's events", () => {
  test("a run that records to the ledger keeps its stream, and it replays as the writer wrote it", async () => {
    const dir = checkout();
    await runOpLocally(op, new Map([["make", ok]]), PROFILES, undefined, {
      runId: "r-settled",
      ledger: { cwd: dir },
      cwd: dir,
      gates: memoryGateLedgerPort(),
    });
    const stored = (await findStoredRun(dir, "r-settled"))!;
    expect(stored.file.startsWith(join(dir, ".git", "chant", "run-events"))).toBe(true);
    expect(stored.name).toBe("deploy-api");

    const lines: string[] = [];
    const settle = await readRunEvents(stored.file, (_e, line) => lines.push(line));
    const events = checkRunEventLines(lines);
    expect(settle?.type).toBe("run-settle");
    expect(events.map((e) => e.type)).toContain("step-settle");
    expect(lines.join("")).toBe(readFileSync(stored.file, "utf8"));
  });

  test("an Op name stands for its newest run", async () => {
    const dir = checkout();
    for (const runId of ["r-1", "r-2"]) {
      await runOpLocally(op, new Map([["make", ok]]), PROFILES, undefined, { runId, ledger: { cwd: dir }, cwd: dir, gates: memoryGateLedgerPort() });
      await new Promise((r) => setTimeout(r, 15));
    }
    expect((await findStoredRun(dir, "deploy-api"))?.runId).toBe("r-2");
    expect((await listStoredRuns(dir)).map((r) => r.runId)).toEqual(["r-2", "r-1"]);
    expect(await findStoredRun(dir, "nothing")).toBeNull();
  });

  test("a run with no ledger (--no-record) keeps nothing", async () => {
    const dir = checkout();
    await runOpLocally(op, new Map([["make", ok]]), PROFILES, undefined, { runId: "r-none", cwd: dir, gates: memoryGateLedgerPort() });
    const events = await runEventsDir(dir);
    expect(events === null || !existsSync(events)).toBe(true);
  });
});

describe("a run in progress", () => {
  async function inFlight() {
    const dir = checkout();
    const store = (await openRunEventStore(dir, "r-live"))!;
    const stream = openRunEventStream(runEventRunOf({ kind: "op", name: "deploy-api", runId: "r-live" }), store.write);
    return { dir, store, stream };
  }

  test("replays what has been written so far, and not a half-written last line", async () => {
    const { store, stream } = await inFlight();
    stream.emit({ type: "run-start", waves: null });
    stream.emit({ type: "phase-start", component: null, phase: "Build" });
    appendFileSync(store.path, '{"type":"step-st');
    const seen: RunEvent[] = [];
    const settle = await readRunEvents(store.path, (e) => seen.push(e));
    expect(settle).toBeUndefined();
    expect(seen.map((e) => e.type)).toEqual(["run-start", "phase-start"]);
  });

  test("--follow streams each event as it is written and ends at run-settle", async () => {
    const { store, stream } = await inFlight();
    stream.emit({ type: "run-start", waves: null });
    const seen: string[] = [];
    const follow = readRunEvents(store.path, (e) => seen.push(`${e.seq}:${e.type}`), { follow: true, pollMs: 5, idleMs: 3000 });

    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual(["0:run-start"]);
    stream.emit({ type: "phase-start", component: null, phase: "Build" });
    stream.emit({ type: "step-start", component: null, phase: "Build", step: "make" });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual(["0:run-start", "1:phase-start", "2:step-start"]);
    stream.settle("ok");

    const settle = await follow;
    expect(settle?.type).toBe("run-settle");
    expect(seen.at(-1)).toBe("3:run-settle");
  });

  test("--follow waits for a file that is not there yet", async () => {
    const dir = checkout();
    const file = join((await runEventsDir(dir))!, "later.jsonl");
    const seen: string[] = [];
    const follow = readRunEvents(file, (e) => seen.push(e.type), { follow: true, pollMs: 5, idleMs: 3000 });
    await new Promise((r) => setTimeout(r, 20));
    const store = (await openRunEventStore(dir, "later"))!;
    const stream = openRunEventStream(runEventRunOf({ kind: "op", name: "x", runId: "later" }), store.write);
    stream.settle("failed", "boom");
    expect((await follow)?.type).toBe("run-settle");
    expect(seen).toEqual(["run-start", "run-settle"]);
  });

  test("an aborted follow returns without a verdict", async () => {
    const { store, stream } = await inFlight();
    stream.emit({ type: "run-start", waves: null });
    const ac = new AbortController();
    const follow = readRunEvents(store.path, () => {}, { follow: true, pollMs: 5, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    expect(await follow).toBeUndefined();
  });
});
