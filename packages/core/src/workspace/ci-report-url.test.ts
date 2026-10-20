/**
 * #4160: the report URL a workspace declares as `ci.reportUrl`. `chant ci
 * run`, `ci serve` and `ci runs` use it when `--report-url` is not given, the
 * flag wins, and `chant workspace ls --json` carries it for readers.
 *
 * The jobs are real `ci run` jobs in a temp repository with a stub chant and
 * file:// report URLs in other temp directories. Nothing is pushed and no
 * test makes a network call: `ci serve` is stopped by its first poll, which
 * has no forge to reach.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanScratch, contract, declaration, git, repoFixture, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { parseArgs } from "../cli/parse-args";
import type { CommandContext } from "../cli/registry";
import { declaredReportUrl, reportUrlOf } from "./ci-report-url";
import { runCiRun } from "./ci-run";
import { runCiServe } from "./ci-serve";
import { CI_RUN_INDEX_KEY, runCiRuns, type CiRunIndex } from "./ci-run-index";
import { listWorkspace, type LsDocument } from "./ls";
import lsSchema from "./ls.schema.json";

const home = process.cwd();
afterEach(() => {
  process.chdir(home);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cleanScratch();
});

const MEMBERS = [{ name: "app", dir: "app", kind: "other", because: "the app" }];
const urlOf = (dir: string) => pathToFileURL(dir).href;
const reportsDir = () => scratchDir("chant-report-url-reports-");
const indexOf = (dir: string): CiRunIndex => JSON.parse(readFileSync(join(dir, CI_RUN_INDEX_KEY), "utf-8"));

/** One member and two commits. The declaration in the working tree is rewritten per test. */
const repoTemplate = repoFixture(() => {
  const root = scratchDir("chant-report-url-template-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.com");
  writeFiles(root, { "chant.workspace.json": declaration(MEMBERS), ".gitignore": ".chant/pr/\n", "app/a.txt": "a\n" });
  const commit = (msg: string) => {
    execFileSync("git", ["-c", "commit.gpgsign=false", "add", "-A"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", msg], { cwd: root, stdio: "ignore" });
  };
  commit("init");
  writeFiles(root, { "app/a.txt": "b\n" });
  commit("change");
  return root;
}, "chant-report-url-");

/** A copy of the repository whose declaration sets `ci` as given, and a stub chant that writes an empty report. */
function workspace(ci?: Record<string, unknown>): { root: string; app: string; base: string; chant: string } {
  const root = repoTemplate();
  writeFiles(root, { "chant.workspace.json": declaration(MEMBERS, ci ? { ci } : {}) });
  const chant = join(scratchDir("chant-report-url-bin-"), "chant");
  writeFileSync(chant, ["#!/bin/sh", "mkdir -p .chant/pr", 'echo "{}" > ".chant/pr/$2.json"', "exit 0", ""].join("\n"));
  chmodSync(chant, 0o755);
  return { root, app: join(root, "app"), base: git(root, "rev-parse", "HEAD~1"), chant };
}

/** Run a ci command line in `cwd`, with what it printed. */
async function cli(cwd: string, argv: string[], run: (ctx: CommandContext) => Promise<number>) {
  process.chdir(cwd);
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(String(s)));
  vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(String(s)));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const code = await run({ args: parseArgs(argv) } as unknown as CommandContext);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const runPlan = (w: ReturnType<typeof workspace>, extra: string[] = []) =>
  cli(
    w.app,
    ["ci", "run", "plan", "--env", "prod", "--base", w.base, "--pr", "7", "--forge", "forgejo", "--no-status", "--chant", w.chant, "-o", join(scratchDir("chant-report-url-out-"), "pr"), ...extra],
    runCiRun,
  );

describe("reportUrlOf", () => {
  test("the flag wins, else the declared URL, else none", async () => {
    const w = workspace({ reportUrl: "s3://acme-reports/prod/" });
    expect(await declaredReportUrl(w.app)).toBe("s3://acme-reports/prod");
    expect(await reportUrlOf(undefined, w.root)).toBe("s3://acme-reports/prod");
    expect(await reportUrlOf("file:///elsewhere", w.app)).toBe("file:///elsewhere");
    expect(await reportUrlOf(undefined, workspace().app)).toBeUndefined();
  });

  test("a directory outside any workspace reads nothing", async () => {
    expect(await reportUrlOf(undefined, scratchDir("chant-report-url-plain-"))).toBeUndefined();
  });

  test("a declared URL no job can upload to fails with its place and reason code, unless the flag is given", async () => {
    const w = workspace({ reportUrl: "https://reports.example/acme" });
    await expect(declaredReportUrl(w.app)).rejects.toThrow(/chant\.workspace\.json:\d+:\d+: ci\.reportUrl https:\/\/reports\.example\/acme: takes an s3:\/\/<bucket>\/<prefix> or file:\/\/<directory> URL \[declaration-invalid\]/);
    expect(await reportUrlOf("file:///elsewhere", w.app)).toBe("file:///elsewhere");
  });
});

describe("chant workspace ls --json carries ci.reportUrl", () => {
  const { expectValid } = contract(lsSchema);
  const ciOf = (doc: LsDocument) => {
    if ("error" in doc) throw new Error(doc.error.message);
    return doc.ci;
  };

  test("present when declared, and the document validates", () => {
    const doc = listWorkspace({ cwd: workspace({ reportUrl: "s3://acme-reports/prod" }).root });
    expectValid(doc);
    expect(ciOf(doc)).toEqual({ green: null, reportUrl: "s3://acme-reports/prod" });
  });

  test("absent when the ci block sets none, and ci stays null with no ci block", () => {
    const green = { branch: "main", phases: { build: ["build"] }, require: ["build"] };
    const withGreen = listWorkspace({ cwd: workspace({ green }).root });
    expectValid(withGreen);
    expect(ciOf(withGreen)).not.toHaveProperty("reportUrl");
    expect(ciOf(listWorkspace({ cwd: workspace().root }))).toBeNull();
  });

  test("an invalid one is the declaration-invalid failure", () => {
    const doc = listWorkspace({ cwd: workspace({ reportUrl: "ftp://x/y" }).root });
    expectValid(doc);
    expect(doc).toMatchObject({ error: { code: "declaration-invalid", location: { file: "chant.workspace.json" } } });
  });
});

describe("chant ci run", () => {
  // The two whole jobs run once, in beforeAll, and the tests below read what
  // they left, as ci-run.test.ts does (#4115, #4124). The first job of a file
  // pays for loading the job's modules, which on a loaded CI shard came to
  // over the unit budget (#2817); a file's beforeAll is not counted in it.
  const ran: Record<"declared" | "flag", { code: number; err: string; declared: CiRunIndex | null; flag: CiRunIndex | null }> = {} as never;
  beforeAll(async () => {
    const read = (dir: string) => (existsSync(join(dir, CI_RUN_INDEX_KEY)) ? indexOf(dir) : null);
    for (const kind of ["declared", "flag"] as const) {
      const declared = reportsDir();
      const flag = reportsDir();
      const w = workspace({ reportUrl: urlOf(declared) });
      const r = await runPlan(w, kind === "flag" ? ["--report-url", urlOf(flag)] : []);
      ran[kind] = { code: r.code, err: r.err, declared: read(declared), flag: read(flag) };
      process.chdir(home);
      vi.restoreAllMocks();
    }
  }, 60_000);

  test("without --report-url the job's run index goes to the declared URL", () => {
    const r = ran.declared;
    expect(r.code, r.err).toBe(0);
    expect(r.declared?.runs).toHaveLength(1);
    expect(r.declared?.runs[0]).toMatchObject({ job: "plan", pr: 7 });
  });

  test("--report-url wins over the declared URL", () => {
    const r = ran.flag;
    expect(r.code, r.err).toBe(0);
    expect(r.flag?.runs).toHaveLength(1);
    expect(r.declared).toBeNull();
  });

  test("an invalid declared URL stops the job before it runs", async () => {
    const w = workspace({ reportUrl: "https://reports.example/acme" });
    const r = await runPlan(w);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/\[declaration-invalid\]/);
  });
});

describe("chant ci runs", () => {
  test("lists the index at the declared URL, and --report-url wins", async () => {
    const declared = reportsDir();
    const w = workspace({ reportUrl: urlOf(declared) });
    expect((await runPlan(w)).code).toBe(0);

    const listed = await cli(w.app, ["ci", "runs", "--json"], runCiRuns);
    expect(listed.code, listed.err).toBe(0);
    expect((JSON.parse(listed.out) as CiRunIndex).runs).toHaveLength(1);

    const other = reportsDir();
    const flagged = await cli(w.app, ["ci", "runs", "--report-url", urlOf(other)], runCiRuns);
    expect(flagged.code).toBe(1);
    expect(flagged.err).toContain(`there is no run index at ${urlOf(other)}`);
  });

  test("with neither a flag nor a declared URL it says how to name one", async () => {
    const r = await cli(workspace().root, ["ci", "runs"], runCiRuns);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--report-url names where the index is kept, unless the workspace declares ci.reportUrl");
  });
});

describe("chant ci serve", () => {
  // No token and no server: the first poll fails, so the serve stops without reaching a forge.
  beforeEach(() => {
    for (const name of ["CHANT_FORGE_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_SERVER_URL", "CHANT_RUNNER_KEY"]) vi.stubEnv(name, undefined);
  });
  const SERVE = ["ci", "serve", "--forge", "forgejo", "--repo", "demo/estate", "--env", "local", "--once", "--unsigned", "--image", "node:22-bookworm"];

  test("says it uses the declared URL when --report-url is not given", async () => {
    const declared = reportsDir();
    const w = workspace({ reportUrl: urlOf(declared) });
    const state = join(scratchDir("chant-report-url-state-"), "ci-serve");
    const r = await cli(w.root, [...SERVE, "--state", state], runCiServe);
    expect(r.err).toContain(`ci serve: reports and the run index go to ${urlOf(declared)}, the declaration's ci.reportUrl`);
  });

  test("says nothing of the declaration when --report-url is given", async () => {
    const w = workspace({ reportUrl: urlOf(reportsDir()) });
    const state = join(scratchDir("chant-report-url-state-"), "ci-serve");
    const r = await cli(w.root, [...SERVE, "--state", state, "--report-url", urlOf(reportsDir())], runCiServe);
    expect(r.err).not.toContain("ci.reportUrl");
  });
});
