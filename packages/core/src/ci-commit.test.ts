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
  type CommitRunCommand,
  type CommitSettings,
  type OpCommitSpec,
} from "./ci-commit";
import { assertProductWords, parseProductComment } from "./ci-product-words";
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
  heads: () => PullRequestHead;
  approvals: Map<string, string>;
  canWrite: boolean;
}

function world(): World {
  const r = repo();
  const w: World = { r, records: [], replies: [], approvals: new Map(), canWrite: true, heads: () => ({ sha: sh(["rev-parse", "refs/heads/feature"], r.origin).trim(), branch: "feature", open: true, sameRepo: true }) };
  return w;
}

async function cycle(w: World, s: CommitSettings, o: { event?: unknown; command?: CommitRunCommand; env?: Record<string, string> } = {}) {
  const d = tmp("dir");
  const forge = {
    pullRequestHead: async () => w.heads(),
    userCanWrite: async () => w.canWrite,
    addComment: async (_pr: number, body: string) => {
      w.replies.push(body);
      return { url: "" } as never;
    },
  };
  const event = o.event ?? (s.on === "comment" ? comment() : checkEvent);
  const env = o.env ?? {};
  const approval = async (_pr: number, sha: string) => w.approvals.get(sha);
  const readRuns = async () => w.records;
  const decision = await prepareCommitRun({ settings: s, words, dir: d, env, event, forge, readRuns, approval, git: w.r.git, now: NOW });
  const ran = await runCommit({ settings: s, dir: d, checkout: w.r.checkout, workDir: join(tmp("work"), "w"), env: { PATH: process.env.PATH }, git: w.r.git, runCommand: o.command ?? formatter() });
  let t = NOW.getTime();
  const out = await landCommitChange({
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
    const bad = (spec: Partial<OpCommitSpec>) => () => settings(spec);
    expect(bad({ allowed: [] })).toThrow(/allowed names at least one path/);
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

  test("reads the merge request on GitLab", async () => {
    const w = world();
    const { out } = await cycle(w, check(), { event: {}, env: { GITLAB_CI: "true", CI_MERGE_REQUEST_IID: "7" } });
    expect(out.result).toBe("pushed");
  });
});
