/**
 * #4979: the wave stop a comment writes before a re-run, `_waves/<op>.stops.json`
 * on `chant/lifecycle`, and what a wave job says when it waits behind it.
 */
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWaveStops, renderWaveStops, setWaveStop, waveStopAt, waveStopLine, waveStopped, WAVE_STOPS_KEPT } from "./wave-stop";

const SHA = "a".repeat(40);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-wave-stop-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@chant.dev");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# t\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("the stops file (#4979)", () => {
  test("reads back what it wrote, drops what is not a stop, and keeps the newest", () => {
    const file = { version: 1 as const, stops: { [SHA]: { through: 2, at: "2026-11-10T00:00:00.000Z", by: "alice", pr: 12 } } };
    expect(parseWaveStops(renderWaveStops(file))).toEqual(file);
    expect(parseWaveStops('{"version":1,"stops":{"nope":{"through":1,"at":"x"},"' + SHA + '":{"through":0,"at":"x"}}}')).toEqual({ version: 1, stops: {} });
    expect(parseWaveStops("not json")).toEqual({ version: 1, stops: {} });
    const many = { version: 1 as const, stops: Object.fromEntries(Array.from({ length: WAVE_STOPS_KEPT + 5 }, (_, i) => [i.toString(16).padStart(40, "0"), { through: 1, at: `2026-11-10T00:00:${String(i).padStart(2, "0")}.000Z` }])) };
    const kept = parseWaveStops(renderWaveStops(many)).stops;
    expect(Object.keys(kept)).toHaveLength(WAVE_STOPS_KEPT);
    expect(kept["0".repeat(40)]).toBeUndefined();
  });

  test("a wave after the stop waits, and the stop's own wave runs", () => {
    const stop = { through: 2, at: "x" };
    expect(waveStopped(stop, 2)).toBe(false);
    expect(waveStopped(stop, 3)).toBe(true);
    expect(waveStopped(undefined, 9)).toBe(false);
  });
});

describe("a stop on chant/lifecycle (#4979)", () => {
  test("is written for a commit, read by the wave job at that commit, and cleared", async () => {
    const dir = initRepo();
    const head = git(dir, "rev-parse", "HEAD");
    expect(await waveStopLine("tf-apply", 3, { cwd: dir })).toBeUndefined();
    expect(await setWaveStop("tf-apply", head, { through: 2, at: "2026-11-10T00:00:00.000Z", by: "alice", pr: 12 }, { cwd: dir })).toEqual({ changed: true, pushed: false });
    expect(await waveStopAt("tf-apply", head, { cwd: dir })).toEqual({ through: 2, at: "2026-11-10T00:00:00.000Z", by: "alice", pr: 12 });
    expect(git(dir, "show", "chant/lifecycle:_waves/tf-apply.stops.json")).toContain('"through": 2');
    expect(await waveStopLine("tf-apply", 2, { cwd: dir })).toBeUndefined();
    expect(await waveStopLine("tf-apply", 3, { cwd: dir })).toBe(`wave 3 waits: alice's comment on pull request 12 ran tf-apply again at ${head.slice(0, 12)} through wave 2; comment the apply again without a wave to run the waves after it`);
    // Another op's waves, and another commit, are not stopped.
    expect(await waveStopLine("other", 3, { cwd: dir })).toBeUndefined();
    expect(await waveStopAt("tf-apply", SHA, { cwd: dir })).toBeUndefined();
    expect(await setWaveStop("tf-apply", head, null, { cwd: dir })).toEqual({ changed: true, pushed: false });
    expect(await waveStopLine("tf-apply", 3, { cwd: dir })).toBeUndefined();
    expect(await setWaveStop("tf-apply", head, null, { cwd: dir })).toEqual({ changed: false, pushed: false });
  });

  test("refuses an op or a commit that is not one", async () => {
    await expect(setWaveStop("a b", SHA, null)).rejects.toThrow(/not a stops file name/);
    await expect(setWaveStop("tf-apply", "main", null)).rejects.toThrow(/not a commit sha/);
  });
});
