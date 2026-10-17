/** #4036: `chant lifecycle gc [--yes] [--push] [--json]`, in temp repos. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ParsedArgs } from "../registry";
import { runLifecycleGc } from "./lifecycle-gc";
import { writeLedgerFiles } from "../../lifecycle/git";
import { makeRelease } from "../../lifecycle/release-store";
import type { GcReport } from "../../lifecycle/retention";

function args(o: Partial<ParsedArgs>): ParsedArgs {
  return { command: "lifecycle", path: ".", format: "", fix: false, watch: false, verbose: false, help: false, live: false, ...o };
}

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf-8" }).trim();

let dir: string;
let cwd: string;
let out: string[];
let err: string[];
beforeEach(() => {
  cwd = process.cwd();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-gc-")));
  vi.stubEnv("CHANT_RUN_EVENTS_DIR", join(dir, ".events"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  process.chdir(dir);
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(String(s)));
  vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(String(s)));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

function commitAll(): string {
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return git(dir, "rev-parse", "HEAD");
}

const changeSet = `_change-sets/jcs1-sha256_${"1".repeat(64)}.json`;
const ctx = (o: Partial<ParsedArgs>) => ({ args: args(o), plugins: [], serializers: [] });
const report = (): GcReport => JSON.parse(out.join("\n")) as GcReport;

describe("chant lifecycle gc", () => {
  test("a dry run by default; --yes prunes in one local commit and pushes nothing", async () => {
    writeFileSync(join(dir, "chant.workspace.json"), JSON.stringify({ name: "w", schema: 1, members: [], retention: { changeSets: { days: 0 } } }));
    commitAll();
    await writeLedgerFiles([{ path: changeSet, content: "{}\n", expectPriorSha: null }], "fixture", { cwd: dir });
    const tip = git(dir, "rev-parse", "chant/lifecycle");

    expect(await runLifecycleGc(ctx({}))).toBe(0);
    expect(out[0]).toMatch(/^chant\/lifecycle at [0-9a-f]{12}: would remove 1 change set\(s\), 0 release\(s\) and 0 template\(s\)/);
    expect(err.join("\n")).toContain("Dry run: nothing was removed");
    expect(git(dir, "rev-parse", "chant/lifecycle")).toBe(tip);

    out = [];
    expect(await runLifecycleGc(ctx({ yes: true, json: true }))).toBe(0);
    const r = report();
    expect(r.dryRun).toBe(false);
    expect(r.policy.changeSets.days).toBe(0);
    expect(r.lifecycle.remove.map((f) => f.path)).toEqual([changeSet]);
    expect(r.lifecycle.commit).toBe(git(dir, "rev-parse", "chant/lifecycle"));
    expect(git(dir, "rev-parse", "chant/lifecycle^")).toBe(tip);
    expect(r.lifecycle.pushed).toBe(false);
  });

  test("outside a workspace the defaults apply, and a release of a revoked commit is not promotable", async () => {
    const head = commitAll();
    const cut = (commit: string) => {
      const r = makeRelease({ member: null, commit, artifactDigests: [], targets: [{ env: "prod", templates: [], params: [] }] });
      return { r, line: JSON.stringify({ version: 1, releaseDigest: r.releaseDigest, label: null, actor: "a", timestamp: new Date().toISOString(), runOrigin: null, signature: null }) };
    };
    const revoked = cut(head);
    const fine = cut("b".repeat(40));
    const file = (d: string) => `_releases/${d.replace(/:/g, "_")}.json`;
    await writeLedgerFiles(
      [
        { path: changeSet, content: "{}\n" },
        { path: file(revoked.r.releaseDigest), content: `${JSON.stringify(revoked.r)}\n` },
        { path: file(fine.r.releaseDigest), content: `${JSON.stringify(fine.r)}\n` },
        { path: "_releases/cuts.jsonl", content: `${revoked.line}\n${fine.line}\n` },
      ],
      "fixture",
      { cwd: dir },
    );
    git(dir, "tag", `ci/revoked/${head}`, head);

    expect(await runLifecycleGc(ctx({ json: true }))).toBe(0);
    const r = report();
    expect(r.policy.releases).toEqual({ days: 14, keep: 10 });
    expect(r.lifecycle.remove.map((f) => f.path)).toEqual([file(revoked.r.releaseDigest)]);
    expect(r.lifecycle.keep.map((f) => [f.path, f.reasons.map((x) => x.code)])).toEqual(
      expect.arrayContaining([[changeSet, ["within-window"]], [file(fine.r.releaseDigest), ["newest", "within-window"]]]),
    );
  });

  test("a workspace whose declaration can't be read prunes nothing", async () => {
    writeFileSync(join(dir, "chant.workspace.json"), JSON.stringify({ name: "w", schema: 1, members: [], retention: { changeSets: { days: -1 } } }));
    commitAll();
    expect(await runLifecycleGc(ctx({ yes: true }))).toBe(1);
    expect(err.join("\n")).toContain("its retention policy is unknown and nothing is pruned");
  });

  test("a directory outside git is refused", async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-gc-plain-")));
    try {
      process.chdir(plain);
      expect(await runLifecycleGc(ctx({}))).toBe(1);
      expect(err.join("\n")).toContain("not in a git repository");
    } finally {
      process.chdir(dir);
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
