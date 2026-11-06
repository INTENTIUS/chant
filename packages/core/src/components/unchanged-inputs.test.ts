/**
 * A component a release leaves alone (#4695): its declared inputs compared with
 * the release the environment runs it from.
 */
import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTestDir } from "@intentius/chant-test-utils";
import { compareInputs, gitNormalizedCompare, unchangedRecord, type ChangedPaths, type NormalizedCompare } from "./unchanged-inputs";
import { makeRelease, type Release } from "../lifecycle/release-store";
import type { ReleaseRecord } from "../lifecycle/release-ledger";

const release = (commit: string, opts: { region?: string; template?: string } = {}): Release =>
  makeRelease({
    member: null,
    commit: commit.repeat(40),
    artifactDigests: [],
    targets: [
      {
        env: "prod",
        templates: [{ component: "control", path: "dist/fly.json", digest: opts.template ?? "sha256:fly" }],
        params: [{ name: "region", value: opts.region ?? "ewr", source: "default" }],
      },
    ],
  });

const before = release("a");
const record = (over: Partial<ReleaseRecord> = {}): ReleaseRecord => ({
  version: 1,
  component: "control",
  env: "prod",
  digest: "sha256:image",
  gitSha: "a".repeat(40),
  runId: "run-1",
  timestamp: "2026-11-01T10:00:00.000Z",
  actor: "ci",
  releaseDigest: before.releaseDigest,
  ...over,
});

const noChange: ChangedPaths = () => [];
const compare = (now: Release, opts: { current?: ReleaseRecord | undefined; changedPaths?: ChangedPaths; params?: string[]; stored?: Release[] } = {}) =>
  compareInputs({
    component: "control",
    inputs: { paths: ["../crates/control"], params: opts.params ?? ["region"] },
    env: "prod",
    release: now,
    current: "current" in opts ? opts.current : record(),
    readRelease: async (d) => (opts.stored ?? [before]).find((r) => r.releaseDigest === d) ?? null,
    changedPaths: opts.changedPaths ?? noChange,
  });

describe("compareInputs", () => {
  test("unchanged when the paths, the params and the deploy files are the same", async () => {
    const seen: unknown[] = [];
    const verdict = await compare(release("b"), { changedPaths: (from, to, paths) => (seen.push([from, to, paths]), []) });
    expect(verdict).toEqual({ unchanged: true, since: record(), recorded: false });
    expect(seen).toEqual([["a".repeat(40), "b".repeat(40), ["../crates/control"]]]);
  });

  test("a changed path, param or deploy file deploys it, and says which", async () => {
    expect(await compare(release("b"), { changedPaths: () => ["crates/control/src/main.rs"] })).toEqual({
      unchanged: false,
      reason: expect.stringMatching(/1 input file\(s\) changed since a{12}, such as crates\/control\/src\/main\.rs/),
    });
    expect(await compare(release("b", { region: "iad" }))).toEqual({ unchanged: false, reason: 'param region is "iad", was "ewr"' });
    expect(await compare(release("b", { template: "sha256:other" }))).toEqual({ unchanged: false, reason: expect.stringMatching(/the files its deploy reads in the "prod" target changed/) });
  });

  test("anything it can't compare deploys it", async () => {
    expect(await compare(release("b"), { current: undefined })).toMatchObject({ unchanged: false, reason: '"prod" has no deploy of it' });
    expect(await compare(release("b"), { current: record({ releaseDigest: undefined }) })).toMatchObject({ unchanged: false, reason: expect.stringMatching(/was not made from a release/) });
    expect(await compare(release("b"), { stored: [] })).toMatchObject({ unchanged: false, reason: expect.stringMatching(/is not stored here/) });
    expect(await compare(release("b"), { changedPaths: () => null })).toMatchObject({ unchanged: false, reason: expect.stringMatching(/git can't compare/) });
    const none = await compareInputs({ component: "control", inputs: {}, env: "prod", release: release("b"), current: record(), readRelease: async () => before, changedPaths: noChange });
    expect(none).toMatchObject({ unchanged: false });
  });

  test("a record that already names this release is unchanged, with nothing new to record", async () => {
    expect(await compare(before)).toEqual({ unchanged: true, since: record(), recorded: true });
  });
});

describe("unchangedRecord", () => {
  test("repeats the deploy that stays, under this release, naming it in unchangedSince", () => {
    const since = record({ manifestDigest: "sha256:m", approver: "bob", admission: { op: "control", gate: "prod-release", resolvedAt: "2026-11-01T09:00:00.000Z" } });
    const now = release("b");
    expect(unchangedRecord(since, { releaseDigest: now.releaseDigest, runId: "run-2", timestamp: "2026-11-02T10:00:00.000Z", actor: "ci" })).toEqual({
      component: "control",
      env: "prod",
      digest: "sha256:image",
      gitSha: "a".repeat(40),
      manifestDigest: "sha256:m",
      runId: "run-2",
      timestamp: "2026-11-02T10:00:00.000Z",
      actor: "ci",
      releaseDigest: now.releaseDigest,
      unchangedSince: { env: "prod", runId: "run-1", timestamp: "2026-11-01T10:00:00.000Z" },
    });
  });
});

describe("compareInputs with inputs.normalize (#4718)", () => {
  const blank = "scripts/release blank {path}";
  const inputs = {
    paths: ["../crates/control", "../Cargo.lock", "../Cargo.toml"],
    normalize: [{ paths: ["../Cargo.lock", "../Cargo.toml"], command: blank }],
  };
  /** git diff over `paths`: the changed files, and of those the ones a normalize entry's `../<file>` names. */
  const changedPaths = (changed: string[]): ChangedPaths =>
    (_from, _to, paths) => (paths === inputs.paths ? changed : changed.filter((f) => paths.includes(`../${f}`)));
  const compareN = (changed: string[], normalizedCompare?: NormalizedCompare, over: { inputs?: typeof inputs } = {}) =>
    compareInputs({
      component: "control",
      inputs: over.inputs ?? inputs,
      env: "prod",
      release: release("b"),
      current: record(),
      readRelease: async () => before,
      changedPaths: changedPaths(changed),
      ...(normalizedCompare ? { normalizedCompare } : {}),
    });

  test("a file that is the same after its normalization is unchanged, and the verdict names the normalization", async () => {
    const calls: unknown[] = [];
    const verdict = await compareN(["Cargo.lock", "Cargo.toml"], (command, path, from, to) => (calls.push([command, path, from, to]), { same: true }));
    expect(verdict).toEqual({
      unchanged: true,
      since: record(),
      recorded: false,
      normalized: [
        { path: "Cargo.lock", command: blank },
        { path: "Cargo.toml", command: blank },
      ],
    });
    expect(calls).toEqual([
      [blank, "Cargo.lock", "a".repeat(40), "b".repeat(40)],
      [blank, "Cargo.toml", "a".repeat(40), "b".repeat(40)],
    ]);
  });

  test("a file that differs after its normalization deploys, and says so", async () => {
    expect(await compareN(["Cargo.lock"], () => ({ same: false }))).toEqual({
      unchanged: false,
      reason: `input file Cargo.lock changed since ${"a".repeat(12)}, also after \`${blank}\``,
    });
  });

  test("a normalizer that fails counts the file as changed, with its message", async () => {
    expect(await compareN(["Cargo.lock"], () => ({ error: "`scripts/release blank 'Cargo.lock'` exited 2 on Cargo.lock at aaaaaaaaaaaa: no such kind" }))).toEqual({
      unchanged: false,
      reason: "the normalization of Cargo.lock failed, so it counts as changed: `scripts/release blank 'Cargo.lock'` exited 2 on Cargo.lock at aaaaaaaaaaaa: no such kind",
    });
    // With nothing to run the normalizer, a covered file is changed too.
    expect(await compareN(["Cargo.lock"])).toMatchObject({ unchanged: false, reason: expect.stringMatching(/normalization of Cargo\.lock failed, so it counts as changed: no normalizer runs here/) });
  });

  test("a changed file no normalization covers is compared as before, and no normalizer runs", async () => {
    let ran = 0;
    const counting: NormalizedCompare = () => (ran++, { same: true });
    expect(await compareN(["Cargo.lock", "crates/control/src/main.rs"], counting)).toEqual({
      unchanged: false,
      reason: `1 input file(s) changed since ${"a".repeat(12)}, such as crates/control/src/main.rs`,
    });
    expect(ran).toBe(0);
    // No normalize at all: the plain diff, as before #4718.
    expect(await compareN(["Cargo.lock"], counting, { inputs: { ...inputs, normalize: [] } })).toMatchObject({ unchanged: false, reason: expect.stringMatching(/1 input file\(s\) changed .* such as Cargo\.lock/) });
    expect(ran).toBe(0);
    // Nothing changed: unchanged with nothing normalized.
    expect(await compareN([], counting)).toEqual({ unchanged: true, since: record(), recorded: false });
  });

  test("the first entry that matches a file is the one used", async () => {
    const two = { ...inputs, normalize: [{ paths: ["../Cargo.lock"], command: "first {path}" }, { paths: ["../Cargo.lock", "../Cargo.toml"], command: blank }] };
    const verdict = await compareN(["Cargo.lock", "Cargo.toml"], () => ({ same: true }), { inputs: two });
    expect(verdict).toMatchObject({ unchanged: true, normalized: [{ path: "Cargo.lock", command: "first {path}" }, { path: "Cargo.toml", command: blank }] });
  });
});

describe("gitNormalizedCompare (#4718)", () => {
  const git = (dir: string, ...args: string[]): string => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commitFile = (dir: string, file: string, content: string): string => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), content);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", `change ${file}`);
    return git(dir, "rev-parse", "HEAD");
  };
  // Blanks the version under [package], as Arugula's `scripts/release blank` does for its own crates.
  const blankVersion = `sed -e 's/^version = ".*"/version = "@V@"/'`;

  test("runs the command from the top level on each commit's copy, with {path} from the top level", async () => {
    await withTestDir(async (dir) => {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "test@chant.dev");
      git(dir, "config", "user.name", "Test");
      const a = commitFile(dir, "crates/control/Cargo.toml", `[package]\nname = "control"\nversion = "1.0.0"\n`);
      const b = commitFile(dir, "crates/control/Cargo.toml", `[package]\nname = "control"\nversion = "1.0.1"\n`);
      const c = commitFile(dir, "crates/control/Cargo.toml", `[package]\nname = "control"\nversion = "1.0.1"\n\n[dependencies]\nserde = "1"\n`);
      mkdirSync(join(dir, "ops"), { recursive: true });
      const compare = gitNormalizedCompare(join(dir, "ops"));
      const path = "crates/control/Cargo.toml";

      expect(compare(blankVersion, path, a, b)).toEqual({ same: true });
      expect(compare(blankVersion, path, b, c)).toEqual({ same: false });
      // {path} is the path from the top level, and the command's directory is the top level.
      expect(compare(`test -f {path} && ${blankVersion}`, path, a, b)).toEqual({ same: true });
      // A file missing at one commit is changed.
      expect(compare(blankVersion, "crates/control/Cargo.lock", a, b)).toEqual({ same: false });
      // A failing command is an error naming the command, the file, the commit and what it said.
      expect(compare("echo no such kind >&2; exit 2", path, a, b)).toEqual({ error: `\`echo no such kind >&2; exit 2\` exited 2 on ${path} at ${a.slice(0, 12)}: no such kind` });
    });
  });
});

describe("unchangedRecord with normalized inputs (#4718)", () => {
  test("names each file and its normalization in normalizedInputs", () => {
    const now = release("b");
    const out = unchangedRecord(record(), { releaseDigest: now.releaseDigest, runId: "run-2", timestamp: "2026-11-02T10:00:00.000Z", actor: "ci" }, [
      { path: "Cargo.lock", command: "scripts/release blank {path}" },
    ]);
    expect(out.normalizedInputs).toEqual([{ path: "Cargo.lock", command: "scripts/release blank {path}" }]);
    expect(out.unchangedSince).toEqual({ env: "prod", runId: "run-1", timestamp: "2026-11-01T10:00:00.000Z" });
    expect(unchangedRecord(record(), { releaseDigest: now.releaseDigest, runId: "run-2", timestamp: "2026-11-02T10:00:00.000Z", actor: "ci" }, [])).not.toHaveProperty("normalizedInputs");
  });
});
