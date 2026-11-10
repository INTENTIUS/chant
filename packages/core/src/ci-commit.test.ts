/**
 * The commit job (#4722) against real git repositories, with a fake forge, a
 * fake command and an in-memory ledger: the decision, the run, the landing,
 * the loop guard and the approval refusal.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentGit } from "./ci-agent";
import {
  COMMIT_HEAD_REF,
  COMMIT_TRAILER,
  commitCommandLines,
  commitRefusedPaths,
  commitSettingsEnv,
  commitSettingsFromEnv,
  landCommitChange,
  prepareCommitRun,
  resolveCommitSpec,
  runCommit,
  COMMIT_PR_ENV,
  CI_COMMIT_ARG_FLOOR,
  CI_COMMIT_HARNESS_BREAK_FLOOR,
  CI_COMMIT_REFUSAL_REPLY_FLOOR,
  COMMIT_HARNESS_BREAK_ENV,
  COMMIT_HARNESS_FORGE,
  commitHarnessBreaks,
  commitArgv,
  GITLAB_COMMIT_ARG_VAR,
  type CommitRefusalReply,
  type CommitRunCommand,
  type CommitSettings,
  type OpCommitSpec,
} from "./ci-commit";
import { COMMENT_LEAVES_COMMIT_FLOOR } from "./ci-product";
import { assertProductWords, commitWordOf, parseProductComment } from "./ci-product-words";
import { PLYWOOD } from "./__fixtures__/product-words";
import type { OpRunRecord, OpRunRecordInput } from "./op/runtime";
import type { PullRequestHead } from "./pr-forge";

const words = assertProductWords({ ...PLYWOOD, commands: { ...PLYWOOD.commands, fmt: "commit" as const } });
const NOW = new Date("2026-11-07T12:00:00Z");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(name: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `chant-commit-${name}-`)));
  dirs.push(d);
  return d;
}

function sh(args: string[], cwd: string, input?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, env: { ...process.env, GIT_AUTHOR_NAME: "ana", GIT_AUTHOR_EMAIL: "ana@x", GIT_COMMITTER_NAME: "ana", GIT_COMMITTER_EMAIL: "ana@x" } });
}

function write(root: string, files: Record<string, string>): void {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
}

/** An origin with `main` and a pull request branch `feature`, and a checkout of `main` with the head fetched into the commit ref. */
function repo(): { origin: string; checkout: string; head: string; git: AgentGit } {
  const origin = tmp("origin");
  sh(["init", "-q", "--bare", "-b", "main"], origin);
  const seed = tmp("seed");
  sh(["clone", "-q", origin, seed], tmpdir());
  write(seed, { "main.tf": "a=1\n", "README.md": "x\n" });
  sh(["add", "-A"], seed);
  sh(["commit", "-q", "-m", "init"], seed);
  sh(["push", "-q", "origin", "main"], seed);
  sh(["checkout", "-q", "-b", "feature"], seed);
  write(seed, { "main.tf": "a   =   1\n" });
  sh(["commit", "-q", "-am", "unformatted"], seed);
  sh(["push", "-q", "origin", "feature"], seed);
  const head = sh(["rev-parse", "HEAD"], seed).trim();
  const checkout = tmp("checkout");
  sh(["clone", "-q", origin, checkout], tmpdir());
  sh(["fetch", "-q", "origin", `+refs/heads/feature:${COMMIT_HEAD_REF}`], checkout);
  const git: AgentGit = (args, opts = {}) => sh(["-c", "core.hooksPath=/dev/null", ...args], opts.cwd ?? checkout, opts.input);
  return { origin, checkout, head, git };
}

/** A fake formatter: collapses the spaces in main.tf, and writes `extra` too. */
function formatter(extra: Record<string, string> = {}, exitCode = 0): CommitRunCommand {
  return async (_argv, o) => {
    const { readFileSync } = await import("node:fs");
    const file = join(o.cwd, "main.tf");
    writeFileSync(file, readFileSync(file, "utf8").replace(/ +/g, " ").replace(" = ", "="));
    write(o.cwd, extra);
    return { exitCode, timedOut: false };
  };
}

function settings(extra: Partial<OpCommitSpec> = {}): CommitSettings {
  return resolveCommitSpec("plywood-fmt", { on: "comment", comment: "/plywood fmt", command: ["terraform", "fmt", "-recursive"], allowed: ["main.tf", "modules/"], ...extra }, "plywood");
}

const comment = (body = "/plywood fmt", user = "ana") => ({ comment: { body, user: { login: user } }, issue: { number: 7, pull_request: {} } });
const checkEvent = { pull_request: { number: 7 } };

interface World {
  r: ReturnType<typeof repo>;
  records: OpRunRecord[];
  replies: string[];
  heads: () => PullRequestHead & { base?: string };
  approvals: Map<string, string>;
  canWrite: boolean;
  /** The open pull request whose head is `feature`, for a check that runs on push. */
  pushPr?: number;
}

function world(): World {
  const r = repo();
  const w: World = { r, records: [], replies: [], approvals: new Map(), canWrite: true, pushPr: 7, heads: () => ({ sha: sh(["rev-parse", "refs/heads/feature"], r.origin).trim(), branch: "feature", open: true, sameRepo: true, base: "main" }) };
  return w;
}

async function cycle(w: World, s: CommitSettings, o: { event?: unknown; command?: CommitRunCommand; env?: Record<string, string>; runEnv?: Record<string, string>; refusalReply?: CommitRefusalReply; between?: () => void } = {}) {
  const d = tmp("dir");
  const forge = {
    pullRequestHead: async () => w.heads(),
    userCanWrite: async () => w.canWrite,
    findPullRequest: async (head: string) => (head === "feature" && w.pushPr ? ({ number: w.pushPr, title: "", body: "", head, base: "main" } as never) : undefined),
    addComment: async (_pr: number, body: string) => {
      w.replies.push(body);
      return { url: "" } as never;
    },
  };
  const event = o.event ?? (s.on === "comment" ? comment() : checkEvent);
  const env = o.env ?? {};
  const approval = async (_pr: number, sha: string) => w.approvals.get(sha);
  const readRuns = async () => w.records;
  const pullRequestBase = async () => w.heads().base;
  const decision = await prepareCommitRun({ settings: s, words, dir: d, env, event, forge, pullRequestBase, readRuns, approval, git: w.r.git, now: NOW });
  const ran = await runCommit({ settings: s, dir: d, checkout: w.r.checkout, workDir: join(tmp("work"), "w"), env: { PATH: process.env.PATH, ...o.runEnv }, git: w.r.git, runCommand: o.command ?? formatter() });
  o.between?.();
  let t = NOW.getTime();
  const out = await landCommitChange({
    pullRequestBase,
    settings: s,
    words,
    dir: d,
    workDir: join(tmp("land"), "w"),
    env,
    event,
    forge,
    git: w.r.git,
    push: ({ cwd, ref }) => {
      w.r.git(["push", "-q", "origin", `HEAD:${ref}`], { cwd });
    },
    readRuns,
    approval,
    record: async (input: OpRunRecordInput) => {
      w.records.push({ version: 1, id: String(w.records.length), ...input } as OpRunRecord);
    },
    now: () => new Date((t += 1000)),
    ...(o.refusalReply ? { refusalReply: o.refusalReply } : {}),
  });
  // The next cycle sees the branch as it is now.
  w.r.git(["fetch", "-q", "origin", `+refs/heads/feature:${COMMIT_HEAD_REF}`]);
  return { decision, ran, out };
}

const featureLog = (w: World) => sh(["log", "--format=%s%n%b", "refs/heads/feature"], w.r.origin);

describe("settings", () => {
  test("fill the defaults, round-trip through the job's variables, and refuse what no job could run", () => {
    const s = settings();
    expect(s).toMatchObject({ maxRuns: 3, timeout: 10, findings: [2], env: "local", guarded: [] });
    expect(commitSettingsFromEnv(commitSettingsEnv(s), "plywood")).toEqual(s);
    expect(commitSettingsFromEnv(commitSettingsEnv(settings({ mergeBase: true })), "plywood").mergeBase).toBe(true);
    const bad = (spec: Partial<OpCommitSpec>) => () => settings(spec);
    expect(bad({ allowed: [] })).toThrow(/allowed or allowedFiles names at least one path/);
    expect(bad({ allowed: ["../x"] })).toThrow(/paths from the repository root/);
    expect(bad({ command: [] })).toThrow(/command is an argv/);
    expect(bad({ command: ["-rf"] })).toThrow(/command is an argv/);
    expect(bad({ comment: "fmt" })).toThrow(/needs comment/);
    expect(bad({ tokenEnv: "not a var" })).toThrow(/tokenEnv is a variable name/);
    expect(bad({ findings: [] })).toThrow(/findings lists/);
  });

  test("the comment word maps onto commit and takes nothing after it", () => {
    expect(parseProductComment(words, "/plywood fmt")).toEqual({ kind: "commit", word: "fmt" });
    expect(parseProductComment(words, "/plywood fmt now")).toEqual({ kind: "refused", reason: "`/plywood fmt` takes nothing after it" });
  });

  test("a path outside allowed and a guarded path are both refused", () => {
    expect(commitRefusedPaths(["main.tf", "modules/a.tf", "other.tf", ".github/workflows/x.yml"], settings())).toEqual({ forbidden: [".github/workflows/x.yml"], outside: ["other.tf", ".github/workflows/x.yml"] });
  });

  test("the job lines run the product's bin", () => {
    expect(commitCommandLines("github", "npx --no-install plywood").land).toBe("npx --no-install plywood commit land --forge github --output .chant/commit");
  });
});

describe("the comment trigger", () => {
  test("pushes the command's change to the branch with the trailer, says so, and records it", async () => {
    const w = world();
    const { out } = await cycle(w, settings());
    expect(out).toMatchObject({ result: "pushed", paths: ["main.tf"], requestedBy: "ana", code: 0 });
    expect(sh(["show", "refs/heads/feature:main.tf"], w.r.origin)).toBe("a=1\n");
    expect(featureLog(w)).toContain(`${COMMIT_TRAILER}: plywood-fmt`);
    expect(featureLog(w)).toContain("Requested-by: ana");
    expect(w.replies[0]).toMatch(/^plywood: pushed `[0-9a-f]{8}` to `feature` for ana, from `terraform fmt -recursive`, changing `main.tf`\. Nothing was applied/);
    expect(w.records).toHaveLength(1);
    expect(w.records[0]!.outcomes.commit).toMatchObject({ trigger: "comment", result: "pushed", pr: 7, requestedBy: "ana" });
  });

  test("a second run changes nothing and says so", async () => {
    const w = world();
    await cycle(w, settings());
    const before = sh(["rev-parse", "refs/heads/feature"], w.r.origin);
    const { out } = await cycle(w, settings());
    expect(out).toMatchObject({ result: "refused", reason: "the command changed nothing" });
    expect(sh(["rev-parse", "refs/heads/feature"], w.r.origin)).toBe(before);
    expect(w.replies[1]).toBe("plywood: `terraform fmt -recursive` changed nothing, so nothing was pushed.");
  });

  test("goes ahead on an approved head and says the new commit needs approval again", async () => {
    const w = world();
    w.approvals.set(w.r.head, "bo");
    const { out } = await cycle(w, settings());
    expect(out.result).toBe("pushed");
    expect(w.replies[0]).toContain("was approved by bo; the new commit is planned again and needs approval again");
    expect(w.records[0]!.outcomes.commit).toMatchObject({ approvalVoided: "bo" });
  });

  test("refuses a commenter who cannot write, a fork, another word and a closed pull request, pushing nothing", async () => {
    for (const [setup, reason] of [
      [(w: World) => (w.canWrite = false), /ana cannot write to the repository/],
      [(w: World) => (w.heads = () => ({ sha: w.r.head, branch: "feature", open: true, sameRepo: false })), /comes from a fork/],
      [(w: World) => (w.heads = () => ({ sha: w.r.head, branch: "feature", open: false, sameRepo: true })), /is not open/],
    ] as const) {
      const w = world();
      setup(w);
      const { out } = await cycle(w, settings());
      expect(out.result).toBe("refused");
      expect(out.reason).toMatch(reason);
      expect(sh(["rev-parse", "refs/heads/feature"], w.r.origin).trim()).toBe(w.r.head);
      expect(w.replies).toHaveLength(1);
      expect(w.records).toHaveLength(1);
    }
    const w = world();
    const { out } = await cycle(w, settings(), { event: comment("/plywood up") });
    expect(out.result).toBe("refused");
  });

  test("refuses a head that moved between the jobs", async () => {
    const w = world();
    const real = w.heads;
    let calls = 0;
    w.heads = () => (++calls > 1 ? { ...real(), sha: "c".repeat(40) } : real());
    const { out } = await cycle(w, settings());
    expect(out).toMatchObject({ result: "refused", reason: "the head moved" });
    expect(w.replies[0]).toContain("moved while plywood-fmt ran");
  });

  test("refuses a change outside allowed and one on a guarded path", async () => {
    for (const extra of [{ "other.tf": "x\n" }, { ".github/workflows/x.yml": "on: push\n" }] as Record<string, string>[]) {
      const w = world();
      const { out } = await cycle(w, settings(), { command: formatter(extra) });
      expect(out.result).toBe("refused");
      expect(out.reason).toContain(Object.keys(extra)[0]!);
      expect(sh(["rev-parse", "refs/heads/feature"], w.r.origin).trim()).toBe(w.r.head);
      expect(w.replies[0]).toContain("which plywood-fmt may not change");
    }
  });

  test("allowedFiles lets a matching file in any directory through, and still refuses another file and a guarded path (#4758)", async () => {
    const byName = () => settings({ allowed: [], allowedFiles: ["*.tf", "terragrunt.hcl"] });
    const ok = world();
    const { out } = await cycle(ok, byName(), { command: formatter({ "envs/prod/vpc/main.tf": "a=1\n", "live/terragrunt.hcl": "x=1\n" }) });
    expect(out.result).toBe("pushed");
    for (const extra of [{ "notes.md": "x\n" }, { ".github/workflows/x.tf": "x\n" }, { "main.tfstate": "{}\n" }] as Record<string, string>[]) {
      const w = world();
      const { out: refused } = await cycle(w, byName(), { command: formatter(extra) });
      expect(refused.result).toBe("refused");
      expect(refused.reason).toContain(Object.keys(extra)[0]!);
      expect(sh(["rev-parse", "refs/heads/feature"], w.r.origin).trim()).toBe(w.r.head);
    }
  });

  test("allowedFiles round-trips through the job's variables and refuses a path or nothing at all", () => {
    const s = settings({ allowed: [], allowedFiles: ["*.tf"] });
    expect(commitSettingsFromEnv(commitSettingsEnv(s), "plywood").allowedFiles).toEqual(["*.tf"]);
    expect(() => settings({ allowedFiles: ["modules/*.tf"] })).toThrow(/allowedFiles are file names/);
    expect(() => settings({ allowed: [], allowedFiles: [] })).toThrow(/allowed or allowedFiles/);
  });

  test("a command that fails pushes nothing", async () => {
    const w = world();
    const { out } = await cycle(w, settings(), { command: formatter({}, 3) });
    expect(out).toMatchObject({ result: "failed", reason: "the command exited 3", code: 1 });
    expect(w.replies[0]).toContain("stopped with exit code 3");
  });

  test("stops at maxRuns pushes to one pull request, counted on the ledger", async () => {
    const w = world();
    w.records.push(
      ...[1, 2].map((n) => ({ version: 1, id: `r${n}`, op: "plywood-fmt", env: "local", started: "2026-11-01T00:00:00Z", ended: "2026-11-01T00:00:01Z", status: "ok", labels: {}, phases: [], outcomes: { commit: { pr: 7, result: "pushed" } } }) as unknown as OpRunRecord),
    );
    const { out } = await cycle(w, settings({ maxRuns: 2 }));
    expect(out).toMatchObject({ result: "stopped", reason: "plywood-fmt pushed 2 commits to #7, and its limit is 2" });
  });
});

describe("the check trigger", () => {
  const check = () => settings({ on: "check", comment: undefined });

  test("pushes after a failed check, and a second run on its own commit does nothing", async () => {
    const w = world();
    const first = await cycle(w, check());
    expect(first.out.result).toBe("pushed");
    expect(w.replies).toHaveLength(1);
    // The check runs again on the job's own commit: the loop guard skips it, silently and unrecorded.
    const second = await cycle(w, check());
    expect(second.decision).toMatchObject({ go: false, stop: "skipped", reason: "the head is plywood-fmt's own commit" });
    expect(second.out).toMatchObject({ result: "skipped", code: 0 });
    expect(w.replies).toHaveLength(1);
    expect(w.records).toHaveLength(1);
  });

  test("an empty change lands nothing and says nothing", async () => {
    const w = world();
    const { out } = await cycle(w, check(), { command: async () => ({ exitCode: 0, timedOut: false }) });
    expect(out).toMatchObject({ result: "skipped", reason: "the command changed nothing" });
    expect(w.replies).toHaveLength(0);
    expect(w.records).toHaveLength(0);
  });

  test("refuses once the head's plan is approved, so no approval is voided unasked", async () => {
    const w = world();
    w.approvals.set(w.r.head, "bo");
    const { decision, out } = await cycle(w, check());
    expect(decision).toMatchObject({ go: false, reason: `the plan of ${w.r.head.slice(0, 8)} is approved by bo, and a commit would void that approval` });
    expect(out.result).toBe("refused");
    expect(sh(["rev-parse", "refs/heads/feature"], w.r.origin).trim()).toBe(w.r.head);
    expect(w.replies).toHaveLength(0);
  });

  test("refuses on land too when the approval came while the command ran", async () => {
    const w = world();
    let calls = 0;
    const approve = w.approvals;
    w.approvals = { get: (sha: string) => (++calls > 1 ? "bo" : approve.get(sha)) } as unknown as Map<string, string>;
    const { out } = await cycle(w, check());
    expect(out.result).toBe("refused");
    expect(out.reason).toContain("approved by bo");
    expect(sh(["rev-parse", "refs/heads/feature"], w.r.origin).trim()).toBe(w.r.head);
  });

  test("a check that runs on push finds the branch's open pull request, and a branch with none is skipped silently", async () => {
    const w = world();
    const push = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/feature" };
    const { out } = await cycle(w, check(), { event: { ref: "refs/heads/feature" }, env: push });
    expect(out.result).toBe("pushed");
    expect(w.replies).toHaveLength(1);

    const none = world();
    none.pushPr = undefined;
    const { decision, out: skipped } = await cycle(none, check(), { event: { ref: "refs/heads/feature" }, env: push });
    expect(decision).toMatchObject({ go: false, stop: "skipped", reason: "feature has no open pull request" });
    expect(skipped.result).toBe("skipped");
    expect(none.replies).toHaveLength(0);
    expect(sh(["rev-parse", "refs/heads/feature"], none.r.origin).trim()).toBe(none.r.head);
  });

  test("a GitLab branch pipeline reads its merge request from CI_OPEN_MERGE_REQUESTS, this project's only", async () => {
    const w = world();
    const env = { GITLAB_CI: "true", CI_PROJECT_PATH: "acme/infra", CI_OPEN_MERGE_REQUESTS: "fork/infra!3,acme/infra!7" };
    const { out } = await cycle(w, check(), { event: {}, env });
    expect(out.result).toBe("pushed");
    const other = world();
    const { out: skipped } = await cycle(other, check(), { event: {}, env: { ...env, CI_OPEN_MERGE_REQUESTS: "fork/infra!7" } });
    expect(skipped.result).toBe("skipped");
  });

  test("reads the merge request on GitLab", async () => {
    const w = world();
    const { out } = await cycle(w, check(), { event: {}, env: { GITLAB_CI: "true", CI_MERGE_REQUEST_IID: "7" } });
    expect(out.result).toBe("pushed");
  });
});

/** A commit on origin's main, from a fresh clone. */
function onMain(w: World, files: Record<string, string>, message = "on main"): string {
  const c = tmp("main");
  sh(["clone", "-q", "-b", "main", w.r.origin, c], tmpdir());
  write(c, files);
  sh(["add", "-A"], c);
  sh(["commit", "-q", "-m", message], c);
  sh(["push", "-q", "origin", "main"], c);
  return sh(["rev-parse", "HEAD"], c).trim();
}

describe("mergeBase (#4723)", () => {
  const merging = () => settings({ mergeBase: true });

  test("merges the base tip into the head, runs the command on the merge and pushes one commit with both parents", async () => {
    const w = world();
    const tip = onMain(w, { "migrations/002.sql": "create table b;\n" });
    const { decision, out } = await cycle(w, merging());
    expect(decision).toMatchObject({ go: true, base: "main", baseSha: tip });
    expect(out.result).toBe("pushed");
    expect(out.paths).toEqual(["main.tf"]);
    const parents = sh(["log", "-1", "--format=%P", "refs/heads/feature"], w.r.origin).trim().split(" ");
    expect(parents).toEqual([w.r.head, tip]);
    expect(sh(["show", "refs/heads/feature:migrations/002.sql"], w.r.origin)).toBe("create table b;\n");
    expect(sh(["show", "refs/heads/feature:main.tf"], w.r.origin)).toBe("a=1\n");
    expect(w.replies[0]).toContain("from a merge of `main` and `terraform fmt -recursive`");
  });

  test("refuses a merge that conflicts, running nothing", async () => {
    const w = world();
    onMain(w, { "main.tf": "b=2\n" });
    let ran = false;
    const { out } = await cycle(w, merging(), { command: async () => ((ran = true), { exitCode: 0, timedOut: false }) });
    expect(ran).toBe(false);
    expect(out).toMatchObject({ result: "refused", reason: "merging main into the head conflicts" });
    expect(sh(["rev-parse", "refs/heads/feature"], w.r.origin).trim()).toBe(w.r.head);
    expect(w.replies[0]).toContain("conflicts, so plywood-fmt did not run");
  });

  test("refuses when the base moved while the command ran", async () => {
    const w = world();
    onMain(w, { "migrations/002.sql": "x\n" });
    const { out } = await cycle(w, merging(), { between: () => void onMain(w, { "migrations/003.sql": "y\n" }, "moved") });
    expect(out).toMatchObject({ result: "refused", reason: "the base moved" });
    expect(sh(["rev-parse", "refs/heads/feature"], w.r.origin).trim()).toBe(w.r.head);
  });

  test("refuses a change outside allowed, though the merge itself brings other paths", async () => {
    const w = world();
    onMain(w, { "migrations/002.sql": "x\n" });
    const { out } = await cycle(w, merging(), { command: formatter({ "other.tf": "z\n" }) });
    expect(out.result).toBe("refused");
    expect(out.reason).toBe("the change touches other.tf");
    expect(sh(["rev-parse", "refs/heads/feature"], w.r.origin).trim()).toBe(w.r.head);
  });
});

describe("the command's variables and its refusal reply (#4724)", () => {
  test("commandEnv round-trips through the job's variables and refuses a forge token or the job's own settings", () => {
    const s = settings({ commandEnv: ["DEV_POSTGRES_READER_USER", "DEV_POSTGRES_READER_USER"] });
    expect(s.commandEnv).toEqual(["DEV_POSTGRES_READER_USER"]);
    expect(commitSettingsFromEnv(commitSettingsEnv(s), "plywood")).toEqual(s);
    expect(settings().commandEnv).toEqual([]);
    expect(() => settings({ commandEnv: ["GITHUB_TOKEN"] })).toThrow(/may not pass GITHUB_TOKEN/);
    expect(() => settings({ commandEnv: ["PUSH_TOKEN"], tokenEnv: "PUSH_TOKEN" })).toThrow(/may not pass PUSH_TOKEN/);
    expect(() => settings({ commandEnv: ["CHANT_COMMIT_NAME"] })).toThrow(/may not pass CHANT_COMMIT_NAME/);
    expect(() => settings({ commandEnv: ["not a var"] })).toThrow(/commandEnv is a list of variable names/);
  });

  test("the command sees the named variables and the pull request's number, and nothing else of the job", async () => {
    const w = world();
    let seen: Record<string, string> = {};
    const command: CommitRunCommand = async (argv, o) => {
      seen = o.env;
      return formatter()(argv, o);
    };
    await cycle(w, settings({ commandEnv: ["DEV_POSTGRES_READER_USER"] }), { command, runEnv: { DEV_POSTGRES_READER_USER: "reader", DEV_POSTGRES_WRITER_USER: "writer", GITHUB_TOKEN: "t" } });
    expect(seen.DEV_POSTGRES_READER_USER).toBe("reader");
    expect(seen[COMMIT_PR_ENV]).toBe("7");
    expect(seen.DEV_POSTGRES_WRITER_USER).toBeUndefined();
    expect(seen.GITHUB_TOKEN).toBeUndefined();
  });

  test("a product's reply to a refusal names what the command said, and the run is refused, not failed", async () => {
    const w = world();
    const command: CommitRunCommand = async () => ({ exitCode: 1, timedOut: false, output: "noise\nplywood fmt: refused: main.tf is locked\n" });
    const refusalReply: CommitRefusalReply = ({ rc, output }) => (rc === "1" && output.includes("is locked") ? "`terraform fmt` refused: `main.tf` is locked." : undefined);
    const { out } = await cycle(w, settings(), { command, refusalReply });
    expect(out).toMatchObject({ result: "refused", reason: "the command refused, exiting 1", code: 0 });
    expect(w.replies).toEqual(["plywood: `terraform fmt` refused: `main.tf` is locked. Nothing was pushed."]);
    expect(w.records.at(-1)?.outcomes?.commit).toMatchObject({ result: "refused" });
  });

  test("a refusal the product does not know keeps chant's own reply", async () => {
    const w = world();
    const command: CommitRunCommand = async () => ({ exitCode: 3, timedOut: false, output: "something else\n" });
    const { out } = await cycle(w, settings(), { command, refusalReply: () => undefined });
    expect(out).toMatchObject({ result: "failed", reason: "the command exited 3" });
    expect(w.replies[0]).toContain("stopped with exit code 3");
  });
});

describe("the comment's argument (#4820)", () => {
  const NAME_PATTERN = "^[a-z0-9]+(?:[-_][a-z0-9]+)*$";
  const named = (extra: Partial<OpCommitSpec> = {}) => settings({ commentArg: { pattern: NAME_PATTERN, position: 1 }, ...extra });
  const seeing = (into: (readonly string[])[]): CommitRunCommand => async (argv, o) => {
    into.push(argv);
    return formatter()(argv, o);
  };

  test("the parse reads one argument only for a word that declares it, against its pattern and chant's own", () => {
    const args = { fmt: new RegExp(NAME_PATTERN) };
    expect(parseProductComment(words, "/plywood fmt", {}, args)).toEqual({ kind: "commit", word: "fmt" });
    expect(parseProductComment(words, "/plywood fmt add-note", {}, args)).toEqual({ kind: "commit", word: "fmt", arg: "add-note" });
    expect(parseProductComment(words, "/plywood fmt Add-Note", {}, args)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/`\/plywood fmt` takes nothing, or one name after it/) });
    expect(parseProductComment(words, "/plywood fmt a b", {}, args)).toMatchObject({ kind: "refused" });
    expect(parseProductComment(words, "/plywood fmt --force", {}, args)).toMatchObject({ kind: "refused" });
    // chant's own check holds whatever the product's pattern lets through.
    expect(parseProductComment(words, "/plywood fmt ../x", {}, { fmt: /^.*$/ })).toMatchObject({ kind: "refused" });
    expect(parseProductComment(words, "/plywood fmt $(id)", {}, { fmt: /^.*$/ })).toMatchObject({ kind: "refused" });
    expect(parseProductComment(words, "/plywood fmt add-note")).toEqual({ kind: "refused", reason: "`/plywood fmt` takes nothing after it" });
  });

  test("commentArg round-trips through the job's variables and refuses a loose pattern, a bad position or the check trigger", () => {
    const s = named();
    expect(s.commentArg).toEqual({ pattern: NAME_PATTERN, position: 1 });
    expect(commitSettingsFromEnv(commitSettingsEnv(s), "plywood")).toEqual(s);
    expect(settings().commentArg).toBeUndefined();
    expect(() => named({ commentArg: { pattern: "[a-z]+", position: 1 } })).toThrow(/anchored/);
    expect(() => named({ commentArg: { pattern: "^(?:$", position: 1 } })).toThrow(/pattern/);
    expect(() => named({ commentArg: { pattern: NAME_PATTERN, position: 0 } })).toThrow(/position/);
    expect(() => named({ commentArg: { pattern: NAME_PATTERN, position: 4 } })).toThrow(/position/);
    expect(() => resolveCommitSpec("plywood-fmt", { on: "check", command: ["terraform", "fmt"], allowed: ["main.tf"], commentArg: { pattern: NAME_PATTERN, position: 1 } }, "plywood")).toThrow(/comment trigger/);
  });

  test("commitArgv puts the argument at its position and refuses one the settings do not take", () => {
    expect(commitArgv(named(), "add-note")).toEqual(["terraform", "add-note", "fmt", "-recursive"]);
    expect(commitArgv(named(), undefined)).toEqual(["terraform", "fmt", "-recursive"]);
    expect(() => commitArgv(settings(), "add-note")).toThrow(/takes no argument/);
    expect(() => commitArgv(named(), "Bad")).toThrow(/not a name/);
  });

  test("the comment's argument reaches the command's argv, the commit and the reply", async () => {
    const w = world();
    const argvs: (readonly string[])[] = [];
    const { decision, out } = await cycle(w, named(), { event: comment("/plywood fmt add-note"), command: seeing(argvs) });
    expect(decision.arg).toBe("add-note");
    expect(argvs).toEqual([["terraform", "add-note", "fmt", "-recursive"]]);
    expect(out.result).toBe("pushed");
    expect(featureLog(w)).toContain("/plywood fmt add-note asked for by ana");
    expect(featureLog(w)).toContain("Ran terraform add-note fmt -recursive on ");
    expect(w.replies[0]).toContain("from `terraform add-note fmt -recursive`");
  });

  test("without an argument the argv is the spec's", async () => {
    const w = world();
    const argvs: (readonly string[])[] = [];
    const { decision } = await cycle(w, named(), { command: seeing(argvs) });
    expect(decision.arg).toBeUndefined();
    expect(argvs).toEqual([["terraform", "fmt", "-recursive"]]);
  });

  test("an argument off the pattern is refused before anything runs", async () => {
    const w = world();
    const argvs: (readonly string[])[] = [];
    const { out } = await cycle(w, named(), { event: comment("/plywood fmt Not_ok!"), command: seeing(argvs) });
    expect(argvs).toEqual([]);
    expect(out.result).toBe("refused");
    expect(out.reason).toMatch(/takes nothing, or one name after it/);
    expect(sh(["rev-parse", "refs/heads/feature"], w.r.origin).trim()).toBe(w.r.head);
  });

  test("GitLab takes the argument from its own pipeline variable", async () => {
    const w = world();
    const argvs: (readonly string[])[] = [];
    const env = { GITLAB_CI: "true", CHANT_COMMIT_PR: "7", CHANT_COMMIT: "fmt", [GITLAB_COMMIT_ARG_VAR]: "add-note", GITLAB_USER_LOGIN: "ana" };
    const { out } = await cycle(w, named(), { event: {}, env, command: seeing(argvs) });
    expect(out.result).toBe("pushed");
    expect(argvs).toEqual([["terraform", "add-note", "fmt", "-recursive"]]);
    const bad = world();
    const { out: refused } = await cycle(bad, named(), { event: {}, env: { ...env, [GITLAB_COMMIT_ARG_VAR]: "a b" }, command: seeing([]) });
    expect(refused.result).toBe("refused");
  });

  test("the floor is the release that shipped it", () => {
    expect(CI_COMMIT_ARG_FLOOR).toBe("0.124.78");
  });
});

describe("a comment refused as it is read gets a reply (#4838)", () => {
  const named = () => settings({ commentArg: { pattern: "^[a-z0-9]+(?:[-_][a-z0-9]+)*$", position: 1 } });

  test("a bad argument and a stray word are answered on the pull request, naming the comment and why, on GitHub and Forgejo", async () => {
    // Forgejo's event has GitHub's shape, so the one path answers both.
    for (const [s, body, why] of [
      [named(), "/plywood fmt Bad", "`/plywood fmt` takes nothing, or one name after it matching `^[a-z0-9]+(?:[-_][a-z0-9]+)*$`"],
      [settings(), "/plywood fmt now", "`/plywood fmt` takes nothing after it"],
    ] as const) {
      const w = world();
      const { out } = await cycle(w, s, { event: comment(body) });
      expect(out).toMatchObject({ result: "refused", reason: why, requestedBy: "ana" });
      expect(w.replies).toEqual([`plywood: \`${body}\` was refused: ${why}. plywood-fmt did not run, and nothing was pushed.`]);
      expect(w.records[0]!.outcomes.commit).toMatchObject({ result: "refused", pr: 7, requestedBy: "ana" });
      expect(sh(["rev-parse", "refs/heads/feature"], w.r.origin).trim()).toBe(w.r.head);
    }
  });

  test("GitLab answers a bad argument from its pipeline variables", async () => {
    const w = world();
    const env = { GITLAB_CI: "true", CHANT_COMMIT_PR: "7", CHANT_COMMIT: "fmt", [GITLAB_COMMIT_ARG_VAR]: "Bad", GITLAB_USER_LOGIN: "ana" };
    const { out } = await cycle(w, named(), { event: {}, env });
    expect(out.result).toBe("refused");
    expect(w.replies).toEqual([expect.stringMatching(/^plywood: `\/plywood fmt Bad` was refused: `\/plywood fmt` takes nothing, or one name after it/)]);
  });

  test("a comment for another word gets no reply from this job, and a long or many-line comment is quoted by its first line, cut short", async () => {
    const other = world();
    await cycle(other, settings(), { event: comment("/plywood up") });
    expect(other.replies).toEqual([]);
    const many = world();
    await cycle(many, settings(), { event: comment("/plywood fmt\nand more") });
    expect(many.replies).toEqual(["plywood: `/plywood fmt` was refused: a command is one line, and nothing else in the comment. plywood-fmt did not run, and nothing was pushed."]);
    const long = world();
    await cycle(long, settings(), { event: comment(`/plywood fmt ${"x".repeat(200)}`) });
    expect(long.replies[0]).toMatch(new RegExp(`^plywood: \`/plywood fmt x{84}\\.\\.\\.\` was refused`));
  });

  test("the floor is the release that shipped it", () => {
    expect(CI_COMMIT_REFUSAL_REPLY_FLOOR).toBe("0.124.86");
  });
});

describe("a comment job leaves the commit job's words to it, so a comment gets one reply (#4890)", () => {
  const named = () => settings({ commentArg: { pattern: "^[a-z0-9]+(?:[-_][a-z0-9]+)*$", position: 1 } });
  /** What a comment job that is not the commit job makes of the comment: a refusal is a reply. */
  const commentJob = (body: string, leaveCommit: boolean) => parseProductComment(words, body, {}, {}, { leaveCommit });

  test("a malformed comment for a commit word is answered by the commit job alone", async () => {
    for (const [s, body] of [
      [settings(), "/plywood fmt now"],
      [named(), "/plywood fmt Bad"],
      [settings(), "/plywood fmt\nand more"],
      [settings(), "/plywood\tfmt  now"],
    ] as const) {
      const w = world();
      await cycle(w, s, { event: comment(body) });
      expect(w.replies, body).toHaveLength(1);
      // Without leaveCommit the comment job refused it too: the second reply #4890 is about.
      expect(commentJob(body, false), body).toMatchObject({ kind: "refused" });
      expect(commentJob(body, true), body).toBeUndefined();
      expect(commitWordOf(words, body), body).toBe("fmt");
    }
  });

  test("a well-formed commit comment is the commit job's too, and every other comment is still the comment job's", () => {
    expect(commentJob("/plywood fmt", true)).toBeUndefined();
    expect(commentJob("/plywood up now", true)).toMatchObject({ kind: "refused" });
    expect(commentJob("/plywood up", true)).toEqual({ kind: "apply" });
    expect(commentJob("/plywood fmtx", true)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/the commands are/) });
    expect(commentJob("/plywood", true)).toMatchObject({ kind: "refused" });
    expect(commentJob("/plywoodfmt", true)).toBeUndefined();
    expect(commitWordOf(words, "/plywood up")).toBeUndefined();
    expect(commitWordOf(words, "/plywood constructor")).toBeUndefined();
    expect(commitWordOf(words, 7)).toBeUndefined();
  });

  test("an alias for a commit word is left to the commit job", () => {
    const aliased = assertProductWords({ ...PLYWOOD, commands: { ...PLYWOOD.commands, fmt: "commit" as const }, aliases: [{ from: "pw fmt", command: "commit" as const }] });
    expect(parseProductComment(aliased, "pw fmt")).toEqual({ kind: "commit", word: "fmt" });
    expect(parseProductComment(aliased, "pw fmt", {}, {}, { leaveCommit: true })).toBeUndefined();
  });

  test("the floor is the release that shipped it", () => {
    expect(COMMENT_LEAVES_COMMIT_FLOOR).toBe("0.124.88");
  });
});

describe("the harness's BREAK switch for land (#4836)", () => {
  const harness = (checks: string) => ({ [COMMIT_HARNESS_BREAK_ENV]: checks, BREAK: "1", GITHUB_SERVER_URL: COMMIT_HARNESS_FORGE });

  test("is read only in a BREAK arm on the harness's Forgejo, and refused anywhere else", () => {
    expect(commitHarnessBreaks({})).toEqual({ checks: [] });
    expect(commitHarnessBreaks(harness("paths"))).toEqual({ checks: ["paths"] });
    expect(commitHarnessBreaks({ ...harness("paths, moved-base"), GITHUB_SERVER_URL: `${COMMIT_HARNESS_FORGE}/` })).toEqual({ checks: ["paths", "moved-base"] });
    expect(commitHarnessBreaks({ ...harness("paths"), BREAK: undefined })).toMatchObject({ refused: expect.stringMatching(/only in a BREAK arm of chant's e2e harness/) });
    expect(commitHarnessBreaks({ ...harness("paths"), GITHUB_SERVER_URL: "https://github.com" })).toMatchObject({ refused: expect.stringMatching(/only in a BREAK arm/) });
    expect(commitHarnessBreaks({ ...harness("paths"), GITHUB_SERVER_URL: undefined })).toMatchObject({ refused: expect.any(String) });
    expect(commitHarnessBreaks({ ...harness("paths"), GITLAB_CI: "true" })).toMatchObject({ refused: expect.any(String) });
    expect(commitHarnessBreaks(harness("guarded"))).toMatchObject({ refused: expect.stringMatching(/paths and moved-base/) });
    expect(commitHarnessBreaks(harness(""))).toEqual({ checks: [] });
  });

  test("the harness's Forgejo is the one chant's e2e stack runs", async () => {
    const { HARNESS_HOSTS } = await import("./e2e-harness/stack");
    expect(COMMIT_HARNESS_FORGE).toBe(HARNESS_HOSTS.forgejo);
  });

  test("outside a harness the switch fails the land and pushes nothing", async () => {
    const w = world();
    const { out } = await cycle(w, settings(), { env: { [COMMIT_HARNESS_BREAK_ENV]: "paths" } });
    expect(out).toMatchObject({ result: "failed", code: 1 });
    expect(out.reason).toMatch(new RegExp(COMMIT_HARNESS_BREAK_ENV));
    expect(sh(["rev-parse", "refs/heads/feature"], w.r.origin).trim()).toBe(w.r.head);
    expect(w.replies[0]).toMatch(/only in a BREAK arm.*nothing was pushed/);
  });

  test("paths: a change outside allowed lands, and says the check was off", async () => {
    const w = world();
    const { out } = await cycle(w, settings(), { command: formatter({ "other.tf": "z\n" }), env: harness("paths") });
    expect(out.result).toBe("pushed");
    expect(out.paths).toEqual(["main.tf", "other.tf"]);
    expect(out.reason).toContain("BREAK: the path check was off");
    expect(w.replies[0]).toContain("BREAK: the path check was off");
  });

  test("paths: a guarded path is still refused", async () => {
    const w = world();
    const { out } = await cycle(w, settings(), { command: formatter({ ".github/workflows/x.yml": "on: push\n" }), env: harness("paths") });
    expect(out.result).toBe("refused");
    expect(out.reason).toBe("the change touches .github/workflows/x.yml");
    expect(sh(["rev-parse", "refs/heads/feature"], w.r.origin).trim()).toBe(w.r.head);
  });

  test("moved-base: a base that moved while the command ran lands the merge of the tip the command ran on", async () => {
    const w = world();
    const ran = onMain(w, { "migrations/002.sql": "x\n" });
    const { out } = await cycle(w, settings({ mergeBase: true }), { env: harness("moved-base"), between: () => void onMain(w, { "migrations/003.sql": "y\n" }, "moved") });
    expect(out.result).toBe("pushed");
    expect(out.reason).toContain("BREAK: the moved-base check was off");
    const parents = sh(["log", "-1", "--format=%P", "refs/heads/feature"], w.r.origin).trim().split(" ");
    expect(parents).toEqual([w.r.head, ran]);
  });

  test("one check off leaves the other on", async () => {
    const w = world();
    onMain(w, { "migrations/002.sql": "x\n" });
    const { out } = await cycle(w, settings({ mergeBase: true }), { env: harness("paths"), between: () => void onMain(w, { "migrations/003.sql": "y\n" }, "moved") });
    expect(out).toMatchObject({ result: "refused", reason: "the base moved" });
  });

  test("the floor is the release that shipped it", () => {
    expect(CI_COMMIT_HARNESS_BREAK_FLOOR).toBe("0.124.78");
  });
});
