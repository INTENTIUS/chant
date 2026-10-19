/**
 * #4098: the run index `chant ci run --report-url` keeps at the report URL.
 *
 * The runs are real `ci run` jobs in a temp repository with a stub chant and
 * a file:// report URL in another temp directory. The jobs do not push, so
 * nothing reaches chant/lifecycle or a remote. No test makes a network call.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, declaration, git, repoFixture, scratchDir, validSchema, writeFiles } from "./__fixtures__/contract-repo";
import { ciRun } from "./ci-run";
import { readCiSecrets } from "./ci-secrets";
import {
  addRunEntry,
  CI_RUN_INDEX_KEY,
  CI_RUN_INDEX_LIMIT,
  CI_RUN_INDEX_SCHEMA_ID,
  formatCiRunIndex,
  readCiRunIndex,
  updateCiRunIndex,
  type CiRunIndex,
  type CiRunIndexEntry,
} from "./ci-run-index";
import { parseReportUrl, reportGet, reportKey, type ReportTarget } from "../pr-report-url";
import schema from "./ci-run-index.schema.json";

afterAll(cleanScratch);

const JOB_IMAGE = "chant-ci-run-index-test:local";
const HOST = { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "acme/estate" };

/** The repository every test starts from, built once: one member, and two commits. */
const repoTemplate = repoFixture(() => {
  const root = scratchDir("chant-ci-run-index-template-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.com");
  writeFiles(root, {
    "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }]),
    ".gitignore": ".chant/pr/\n",
    "app/a.txt": "a\n",
  });
  const commit = (msg: string) => {
    execFileSync("git", ["-c", "commit.gpgsign=false", "add", "-A"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", msg], { cwd: root, stdio: "ignore" });
    return git(root, "rev-parse", "HEAD");
  };
  commit("init");
  writeFiles(root, { "app/a.txt": "b\n" });
  commit("change");
  return root;
}, "chant-ci-run-index-");

/** A repository with one member, and a stub chant that writes the report FAKE_REPORT gives it and exits $FAKE_EXIT. */
function workspace(): { app: string; base: string; sha: string; chant: string } {
  const root = repoTemplate();
  const base = git(root, "rev-parse", "HEAD~1");
  const sha = git(root, "rev-parse", "HEAD");
  const file = join(scratchDir("chant-ci-run-index-bin-"), "chant");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      "mkdir -p .chant/pr",
      'if [ -n "$FAKE_REPORT" ]; then printf "%s" "$FAKE_REPORT" > ".chant/pr/$2.json"; else echo "{}" > ".chant/pr/$2.json"; fi',
      'exit "${FAKE_EXIT:-0}"',
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return { app: join(root, "app"), base, sha, chant: file };
}

const reportsDir = () => scratchDir("chant-ci-run-index-reports-");
const urlOf = (dir: string) => pathToFileURL(dir).href;
const indexOf = (dir: string): CiRunIndex => JSON.parse(readFileSync(join(dir, CI_RUN_INDEX_KEY), "utf-8"));

const { expectValid } = contract(schema);

async function job(w: ReturnType<typeof workspace>, dir: string, over: Partial<Parameters<typeof ciRun>[0]> & { hostEnv?: Record<string, string | undefined> } = {}) {
  return ciRun({
    image: JOB_IMAGE,
    cwd: w.app,
    job: "plan",
    env: "prod",
    forge: "forgejo",
    base: w.base,
    pr: 7,
    chant: w.chant,
    hostEnv: HOST,
    push: false,
    output: join(scratchDir("chant-ci-run-index-out-"), "pr"),
    loop: { reportUrl: urlOf(dir) },
    ...over,
  });
}

const ENTRY: CiRunIndexEntry = {
  job: "plan",
  pr: 1,
  commit: "a".repeat(40),
  status: "ok",
  started: "2026-10-18T12:00:00.000Z",
  ended: "2026-10-18T12:00:01.000Z",
  runId: "r0",
  key: reportKey(1, "a".repeat(40)),
  runOrigin: { forge: "chant" },
};

describe("the ci-run-index schema (#4098)", () => {
  test("is a valid schema with the contract's id", () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(CI_RUN_INDEX_SCHEMA_ID);
  });

  test("a failed entry without a failure code does not validate", () => {
    const doc = { $schema: CI_RUN_INDEX_SCHEMA_ID, contract: 1, chant: "0.124.30", updated: "2026-10-18T12:00:00.000Z", runs: [{ ...ENTRY, status: "fail" }] };
    expect(contract(schema).validate(doc)).toBe(false);
    expectValid({ ...doc, runs: [{ ...ENTRY, status: "fail", failure: { code: "command-failed" } }] });
  });
});

describe("chant ci run with --report-url keeps the run index (#4098)", () => {
  test("the index is created, grows newest first, carries every field and validates", async () => {
    const w = workspace();
    const dir = reportsDir();
    const plan = await job(w, dir, { runId: "run-plan" });
    expect(plan.status).toBe("ok");
    expect(plan.warnings).toEqual([]);
    const apply = await job(w, dir, { job: "apply", pr: undefined, runId: "run-apply", hostEnv: { ...HOST, FAKE_REPORT: JSON.stringify({ pr: 7, status: "applied" }) }, passEnv: ["FAKE_REPORT"] });
    expect(apply.status).toBe("ok");

    const index = indexOf(dir);
    expectValid(index);
    expect(index.runs.map((r) => r.runId)).toEqual(["run-apply", "run-plan"]);
    expect(index.runs[1]).toEqual({
      job: "plan",
      pr: 7,
      commit: w.sha,
      status: "ok",
      started: plan.record.started,
      ended: plan.record.ended,
      runId: "run-plan",
      key: `7/${w.sha}/app`,
      member: "app",
      runOrigin: { forge: "chant" },
    });
    // The apply found its pull request in its own report.
    expect(index.runs[0]).toMatchObject({ job: "apply", pr: 7, key: `7/${w.sha}/app` });
    expect(readdirSync(join(dir, "runs"))).toEqual(["index.json"]);
    expect(formatCiRunIndex(index).split("\n")).toHaveLength(2);
  });

  test("a job with no pull request is keyed unknown", async () => {
    const w = workspace();
    const dir = reportsDir();
    await job(w, dir, { job: "apply", pr: undefined, runId: "r-apply" });
    const [run] = indexOf(dir).runs;
    expect(run).toMatchObject({ pr: null, key: `unknown/${w.sha}/app` });
    expectValid(indexOf(dir));
  });

  test("the index keeps the newest entries up to the limit", async () => {
    const w = workspace();
    const dir = reportsDir();
    for (const n of [1, 2, 3]) await job(w, dir, { runId: `run-${n}`, runIndexLimit: 2 });
    expect(indexOf(dir).runs.map((r) => r.runId)).toEqual(["run-3", "run-2"]);
    expect(CI_RUN_INDEX_LIMIT).toBe(200);
  });

  test("a failed job carries its failure code", async () => {
    const w = workspace();
    const dir = reportsDir();
    const failed = await job(w, dir, { runId: "run-fail", hostEnv: { ...HOST, FAKE_EXIT: "3" }, passEnv: ["FAKE_EXIT"] });
    expect(failed.status).toBe("fail");
    const [run] = indexOf(dir).runs;
    expect(run).toMatchObject({ status: "fail", failure: { code: "command-failed" }, runId: "run-fail" });
    expectValid(indexOf(dir));

    const refused = await job(w, dir, {
      job: "apply",
      runId: "run-refused",
      hostEnv: { ...HOST, FAKE_EXIT: "1", FAKE_REPORT: JSON.stringify({ pr: 7, status: "refused", refusal: "not-approved" }) },
      passEnv: ["FAKE_EXIT", "FAKE_REPORT"],
    });
    expect(refused.status).toBe("fail");
    expect(indexOf(dir).runs[0]).toMatchObject({ failure: { code: "not-approved" } });
  });

  test("a secret the job's report names as its failure never reaches the index (#4096)", async () => {
    const w = workspace();
    const dir = reportsDir();
    const SECRET = "s3cret-pass-1";
    const secretsFile = join(scratchDir("chant-ci-run-index-secrets-"), "secrets.env");
    writeFileSync(secretsFile, `DB_PASSWORD=${SECRET}\n`, { mode: 0o600 });
    const leaky = join(scratchDir("chant-ci-run-index-bin-"), "chant");
    writeFileSync(
      leaky,
      [
        "#!/bin/sh",
        "mkdir -p .chant/pr",
        // The refusal becomes the index's failure code, and the message and output carry the secret too.
        'printf \'{"stage":"apply","pr":7,"status":"refused","refusal":"denied-%s","message":"failed with %s"}\' "$DB_PASSWORD" "$DB_PASSWORD" > .chant/pr/pr-apply.json',
        'echo "login refused for $DB_PASSWORD" >&2',
        "exit 3",
        "",
      ].join("\n"),
    );
    chmodSync(leaky, 0o755);
    const r = await job(w, dir, { job: "apply", chant: leaky, runId: "run-leak", secrets: readCiSecrets(secretsFile) });
    expect(r.status).toBe("fail");
    const text = readFileSync(join(dir, CI_RUN_INDEX_KEY), "utf-8");
    expect(text).not.toContain(SECRET);
    expect(indexOf(dir).runs[0]).toMatchObject({ status: "fail", failure: { code: "denied-***" } });
    expectValid(indexOf(dir));
  });

  test("a corrupt index is replaced with a warning and the job stays ok", async () => {
    const w = workspace();
    const dir = reportsDir();
    mkdirSync(join(dir, "runs"));
    writeFileSync(join(dir, CI_RUN_INDEX_KEY), "{ not json");
    const r = await job(w, dir, { runId: "run-after-corrupt" });
    expect(r.status).toBe("ok");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/run index at .*runs\/index\.json is replaced, since it is not JSON/);
    expect(indexOf(dir).runs.map((x) => x.runId)).toEqual(["run-after-corrupt"]);
    expectValid(indexOf(dir));
  });

  test("an index that cannot be read or written warns and leaves the job ok", async () => {
    const w = workspace();
    const dir = reportsDir();
    // A file where the runs folder goes: the index can be neither read nor written.
    writeFileSync(join(dir, "runs"), "in the way");
    const r = await job(w, dir, { runId: "run-blocked" });
    expect(r.status).toBe("ok");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/could not read the run index at .*, so it is not updated/);
    expect(readFileSync(join(dir, "runs"), "utf-8")).toBe("in the way");
  });

  test("a report URL that does not parse warns, and without --report-url nothing is written", async () => {
    const w = workspace();
    const bad = await job(w, reportsDir(), { loop: { reportUrl: "ftp://example.invalid/x" } });
    expect(bad.status).toBe("ok");
    expect(bad.warnings[0]).toMatch(/the run index is not updated: --report-url ftp/);
    const dir = reportsDir();
    const none = await job(w, dir, { loop: {} });
    expect(none.warnings).toEqual([]);
    expect(existsSync(join(dir, "runs"))).toBe(false);
  });
});

describe("updating the index", () => {
  const target = (dir: string): ReportTarget => parseReportUrl(urlOf(dir)) as ReportTarget;

  test("an upload error warns and nothing throws", async () => {
    const warnings: string[] = [];
    await updateCiRunIndex({
      target: target(reportsDir()),
      entry: ENTRY,
      warn: (m) => warnings.push(m),
      put: async () => {
        throw new Error("aws s3 cp exited 1: AccessDenied");
      },
    });
    expect(warnings).toEqual([expect.stringMatching(/could not write the run index at .*: aws s3 cp exited 1: AccessDenied/)]);
  });

  test("a read error other than a missing object leaves the index alone", async () => {
    const warnings: string[] = [];
    let wrote = false;
    await updateCiRunIndex({
      target: target(reportsDir()),
      entry: ENTRY,
      warn: (m) => warnings.push(m),
      get: async () => {
        throw new Error("aws s3 cp exited 1: AccessDenied");
      },
      put: async () => {
        wrote = true;
      },
    });
    expect(wrote).toBe(false);
    expect(warnings[0]).toMatch(/could not read the run index/);
  });

  test("an index of a newer contract is left as it is", async () => {
    const warnings: string[] = [];
    let wrote = false;
    await updateCiRunIndex({
      target: target(reportsDir()),
      entry: ENTRY,
      warn: (m) => warnings.push(m),
      get: async () => JSON.stringify({ contract: 2, runs: [] }),
      put: async () => {
        wrote = true;
      },
    });
    expect(wrote).toBe(false);
    expect(warnings[0]).toMatch(/is contract 2, which this chant does not write/);
  });

  test("updates in one process take turns, and a run id is kept once", async () => {
    const dir = reportsDir();
    const warn = (m: string) => {
      throw new Error(m);
    };
    await Promise.all([1, 2, 3, 4].map((n) => updateCiRunIndex({ target: target(dir), entry: { ...ENTRY, runId: `r${n}` }, warn })));
    expect(indexOf(dir).runs.map((r) => r.runId).sort()).toEqual(["r1", "r2", "r3", "r4"]);
    await updateCiRunIndex({ target: target(dir), entry: { ...ENTRY, runId: "r2", status: "fail", failure: { code: "x" } }, warn });
    const runs = indexOf(dir).runs;
    expect(runs).toHaveLength(4);
    expect(runs[0]).toMatchObject({ runId: "r2", status: "fail" });
    expect(addRunEntry([ENTRY], { ...ENTRY, runId: "r9" }, 1).map((r) => r.runId)).toEqual(["r9"]);
  });

  test("the file write goes through a rename, so no temporary file is left", async () => {
    const dir = reportsDir();
    await updateCiRunIndex({ target: target(dir), entry: ENTRY, warn: () => {} });
    expect(readdirSync(join(dir, "runs"))).toEqual(["index.json"]);
  });

  test("readCiRunIndex reads what was written, null for none, and says why for a bad one", async () => {
    const dir = reportsDir();
    expect(await readCiRunIndex(target(dir))).toBeNull();
    await updateCiRunIndex({ target: target(dir), entry: ENTRY, warn: () => {} });
    expect((await readCiRunIndex(target(dir)))?.runs).toEqual([ENTRY]);
    writeFileSync(join(dir, CI_RUN_INDEX_KEY), "nope");
    await expect(readCiRunIndex(target(dir))).rejects.toThrow(/is unusable: it is not JSON/);
  });

  test("an s3 get treats a missing object as none, with a stub in place of the AWS CLI", async () => {
    const s3 = parseReportUrl("s3://bucket/prefix") as ReportTarget;
    const calls: string[][] = [];
    const absent = reportGet(s3, async (args) => {
      calls.push(args);
      throw new Error("aws s3 cp exited 1: An error occurred (404) when calling the HeadObject operation: Key not found");
    });
    expect(await absent(CI_RUN_INDEX_KEY)).toBeNull();
    expect(calls[0]).toEqual(["s3", "cp", "s3://bucket/prefix/runs/index.json", "-", "--only-show-errors"]);
    const denied = reportGet(s3, async () => {
      throw new Error("aws s3 cp exited 1: AccessDenied");
    });
    await expect(denied(CI_RUN_INDEX_KEY)).rejects.toThrow(/AccessDenied/);
  });
});
