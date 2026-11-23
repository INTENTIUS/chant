/**
 * #5488: a repository's first commit has no parent, so `HEAD^1` names no
 * commit. The gate's rules are read at base so a change cannot choose its own
 * gate, and a root commit has nothing reviewed before it: its base is the
 * empty tree, where the spec is absent and every wave reads as `always`. The
 * commit being applied is never read as its own base. A shallow checkout,
 * whose commit names a parent it does not have, keeps the error.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitShowAtBase, parseOpWavesSpec, readOpWavePolicy, runOpWave, type OpWaveExec } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { commandSpecRender, renderedSpecShow } from "./op-waves-render-spec";
import { baseCommit, gateSignersAt, isEmptyBase, rootCommitBase } from "../gate-decision";
import { pipelineStageShow } from "../pipeline/stage-waves";

const SPEC_FILE = ".chant/op-waves/demo.spec.json";
const SHA1_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const SHA256_EMPTY_TREE = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

const SPEC = {
  name: "demo",
  op: "demo",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  waves: [{ name: "wave-1", gate: "never", runs: [{ target: "a" }] }],
};

const dirs: string[] = [];
let repo: string;
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (...args: string[]) => gitIn(repo, ...args);

function newRepo(objectFormat?: "sha256"): string {
  const dir = mkdtempSync(join(tmpdir(), "op-waves-root-"));
  dirs.push(dir);
  gitIn(dir, "init", "-q", "-b", "main", ...(objectFormat ? [`--object-format=${objectFormat}`] : []));
  gitIn(dir, "config", "user.email", "t@example.com");
  gitIn(dir, "config", "user.name", "t");
  gitIn(dir, "config", "commit.gpgsign", "false");
  mkdirSync(join(dir, ".chant", "op-waves"), { recursive: true });
  // The commit being applied names a gate that would let it through, and a signer of its own.
  writeFileSync(join(dir, SPEC_FILE), JSON.stringify(SPEC));
  writeFileSync(join(dir, ".chant", "allowed_signers"), "mallory ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBZV6IyTcqViNJ8+0g+kb+QgTj6hYRPsx5NfDsJBshb2\n");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "root");
  return dir;
}

beforeEach(() => {
  repo = newRepo();
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("a repository's first commit (#5488)", () => {
  test("the spec reads as absent at base, so each wave's gate is always, never the root commit's own never", () => {
    const rules = readOpWavePolicy(SPEC_FILE, "wave-1", "HEAD^1", repo);
    expect(rules).toMatchObject({ policy: "always", source: "absent-at-base", base: SHA1_EMPTY_TREE });
    expect(rules.base).not.toBe(git("rev-parse", "HEAD"));
    // The other spellings of the first parent read the same.
    for (const base of ["HEAD^", "HEAD~1", "HEAD~"]) expect(readOpWavePolicy(SPEC_FILE, "wave-1", base, repo).base).toBe(SHA1_EMPTY_TREE);
    // A read at the base it answered reads nothing either.
    expect(gitShowAtBase(rules.base, SPEC_FILE, repo)).toEqual({ sha: SHA1_EMPTY_TREE, text: null });
  });

  test("baseCommit agrees: the base is the empty tree, where the change's own signers are not listed", () => {
    const base = baseCommit(repo);
    expect(base).toBe(SHA1_EMPTY_TREE);
    expect(isEmptyBase(base)).toBe(true);
    expect(gateSignersAt(repo, base)).toMatchObject({ active: false, signers: [] });
  });

  test("a sha256 repository's empty tree", () => {
    const sha256 = newRepo("sha256");
    expect(rootCommitBase(sha256, "HEAD^1")).toBe(SHA256_EMPTY_TREE);
    expect(baseCommit(sha256)).toBe(SHA256_EMPTY_TREE);
    expect(readOpWavePolicy(SPEC_FILE, "wave-1", "HEAD^1", sha256)).toMatchObject({ policy: "always", base: SHA256_EMPTY_TREE });
  });

  test("the stage reader and a rendered spec read the same, and the spec command is not run with no commit to run it at", () => {
    expect(readOpWavePolicy(SPEC_FILE, "wave-1", "HEAD^1", repo, pipelineStageShow())).toMatchObject({ policy: "always", base: SHA1_EMPTY_TREE });
    const ran: string[] = [];
    const show = renderedSpecShow(SPEC_FILE, (sha) => (ran.push(sha), JSON.stringify(SPEC)), gitShowAtBase);
    expect(readOpWavePolicy(SPEC_FILE, "wave-1", "HEAD^1", repo, show)).toMatchObject({ policy: "always", source: "absent-at-base" });
    expect(ran).toEqual([]);
    // A product's real command is handed no commit either.
    const command = renderedSpecShow(SPEC_FILE, commandSpecRender([process.execPath, "-e", "process.exit(9)"], SPEC_FILE, repo), gitShowAtBase);
    expect(readOpWavePolicy(SPEC_FILE, "wave-1", "HEAD^1", repo, command).policy).toBe("always");
  });

  test("the wave waits for a person, and the line that names the gate says why", async () => {
    const applied: string[] = [];
    const exec: OpWaveExec = (argv, dir) => {
      if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ planDigest: `sha256:${"1".repeat(64)}`, changes: { create: 1 } }));
      if (argv[1] === "apply") applied.push(argv[2]!);
      return 0;
    };
    const lines: string[] = [];
    const result = await runOpWave({
      spec: parseOpWavesSpec(JSON.stringify(SPEC), "spec"),
      specFile: SPEC_FILE,
      wave: 1,
      cwd: repo,
      exec,
      gates: memoryGateLedgerPort(),
      head: git("rev-parse", "HEAD"),
      log: (l) => lines.push(l),
    });
    expect(result.decision).toMatchObject({ status: "waiting", policy: "always", base: SHA1_EMPTY_TREE });
    expect(applied).toEqual([]);
    expect(lines.join("\n")).toContain("wave 1 (wave-1): gate always: this commit has no parent, so the spec is absent at base and the wave waits for a person's approval");
  });

  test("a shallow checkout that lacks the parent keeps the error", () => {
    git("commit", "-q", "--allow-empty", "-m", "second");
    const shallow = mkdtempSync(join(tmpdir(), "op-waves-shallow-"));
    dirs.push(shallow);
    gitIn(shallow, "clone", "-q", "--depth=1", `file://${repo}`, "clone");
    const clone = join(shallow, "clone");
    expect(rootCommitBase(clone, "HEAD^1")).toBeUndefined();
    expect(() => readOpWavePolicy(SPEC_FILE, "wave-1", "HEAD^1", clone)).toThrow(/the gate policy is read at HEAD\^1, which this checkout does not have/);
    expect(() => readOpWavePolicy(SPEC_FILE, "wave-1", "HEAD^1", clone, pipelineStageShow())).toThrow(/which this checkout does not have/);
  });

  test("a base that names no commit for another reason keeps the error", () => {
    expect(rootCommitBase(repo, "origin/main")).toBeUndefined();
    expect(rootCommitBase(repo, "HEAD^2")).toBeUndefined();
    expect(() => readOpWavePolicy(SPEC_FILE, "wave-1", "origin/main", repo)).toThrow(/which this checkout does not have/);
  });
});
