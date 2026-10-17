/** #4042: `chant run events <run> [--json] [--follow]`. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ParsedArgs } from "../registry";
import { runOpEvents } from "./run";
import { openRunEventStore } from "../../run-event-store";
import { openRunEventStream, runEventRunOf } from "../../run-event-stream";

function args(o: Partial<ParsedArgs>): ParsedArgs {
  return { command: "run", path: ".", format: "", fix: false, watch: false, verbose: false, help: false, live: false, ...o };
}

let dir: string;
let cwd: string;
let out: string[];
beforeEach(() => {
  cwd = process.cwd();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "run-events-cmd-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  process.chdir(dir);
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => (out.push(String(s)), true));
  vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(`${s}\n`));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

async function stream(runId: string, name = "deploy-api") {
  const store = (await openRunEventStore(dir, runId))!;
  return openRunEventStream(runEventRunOf({ kind: "op", name, runId }), store.write);
}

describe("chant run events", () => {
  test("--json replays a settled run's lines and exits with its verdict", async () => {
    const s = await stream("r-done");
    s.emit({ type: "run-start", waves: null });
    s.settle("failed", "boom");
    const exit = await runOpEvents({ args: args({ extraPositional: "r-done", json: true }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    const events = out.join("").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(["run-start", "run-settle"]);
    expect(events[1]).toMatchObject({ status: "failed", error: "boom" });
  });

  test("--json replays a run in progress up to now and exits 0", async () => {
    const s = await stream("r-live");
    s.emit({ type: "run-start", waves: null });
    s.emit({ type: "phase-start", component: null, phase: "Build" });
    const exit = await runOpEvents({ args: args({ extraPositional: "deploy-api", json: true }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(out.join("").trim().split("\n").map((l) => JSON.parse(l).type)).toEqual(["run-start", "phase-start"]);
  });

  test("--follow prints each event of a run in progress, then the verdict", async () => {
    const s = await stream("r-follow");
    s.emit({ type: "run-start", waves: null });
    const done = runOpEvents({ args: args({ extraPositional: "r-follow", json: true, follow: true }), plugins: [], serializers: [] });
    await new Promise((r) => setTimeout(r, 150));
    expect(out.join("").trim().split("\n")).toHaveLength(1);
    s.emit({ type: "phase-start", component: null, phase: "Build" });
    s.emit({ type: "phase-settle", component: null, phase: "Build", status: "gated" });
    s.settle("gated");
    expect(await done).toBe(3);
    expect(out.join("").trim().split("\n").map((l) => JSON.parse(l).type)).toEqual(["run-start", "phase-start", "phase-settle", "run-settle"]);
  });

  test("without --json each event is one line for a person", async () => {
    const s = await stream("r-human");
    s.emit({ type: "run-start", waves: null });
    s.settle("ok");
    expect(await runOpEvents({ args: args({ extraPositional: "r-human" }), plugins: [], serializers: [] })).toBe(0);
    expect(out.join("")).toMatch(/run-start/);
    expect(out.join("")).toMatch(/run-settle\s+ok/);
  });

  test("a run with no kept events is refused by name; no run is refused", async () => {
    expect(await runOpEvents({ args: args({ extraPositional: "nope" }), plugins: [], serializers: [] })).toBe(1);
    expect(await runOpEvents({ args: args({}), plugins: [], serializers: [] })).toBe(1);
    expect(await runOpEvents({ args: args({ extraPositional: "x", on: "fountain" }), plugins: [], serializers: [] })).toBe(1);
  });
});
