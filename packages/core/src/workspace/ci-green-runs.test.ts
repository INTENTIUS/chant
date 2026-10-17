/**
 * #4044: chant run results as a status source for `ci tick`. With
 * `ci.green.source: "runs"` (or `--source runs`) the tick reads Op runs from
 * the run ledger on `chant/lifecycle` instead of a forge's check runs. A run
 * counts only when its record carries a statement signed by a runner key
 * `.chant/trust.json` lists for a principal holding the `runner` role; the
 * tick ignores and reports any other. Every tag it makes is signed, and names
 * the runs behind it.
 *
 * Each test works in its own temp repository with a bare origin, and every
 * key is a throwaway one. Nothing is written in process.cwd().
 */

import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { ciList, ciTick, formatList, formatTick, opRunSigner, readOpRunSource } from "./ci-green";
import { ciForgeFromEnv } from "./ci-green-forge";
import { sshFromEd25519 } from "./trust/dsse";
import { verifyCiTagStatement } from "./trust/ci-tag-statement";
import { verifyOpRunStatement } from "./trust/op-run-statement";
import { appendRunRecord, readRunLedger } from "../lifecycle/run-ledger";
import { runOpLocally, OpRunFailure } from "../op/local-executor";
import type { ActivityFn } from "../op/activity-registry";
import type { OpConfig } from "../op/types";
import type { OpRunRecord } from "../op/runtime";
import listSchema from "./ci-list.schema.json";

afterAll(cleanScratch);

const NOW = new Date("2026-10-06T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const GREEN = { branch: "main", phases: { lint: ["lint"], test: ["test"] }, require: ["lint", "test"], source: "runs" };

/** A throwaway runner key: its PEM and its ssh public key line. */
function runnerKey(): { pem: string; ssh: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), ssh: sshFromEd25519(Buffer.from(jwk.x, "base64url")) };
}

const BOT = runnerKey();
const RUNNERS = [{ principal: "ci-bot", class: "runner" as const, key: BOT.ssh }];

function commitAt(root: string, hours: number, file: string): string {
  writeFiles(root, { [file]: `${file} ${hours}\n` });
  const date = hoursAgo(hours);
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  for (const args of [["add", "-A"], ["commit", "-q", "-m", file]]) {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, stdio: "ignore" });
  }
  return git(root, "rev-parse", "HEAD");
}

/** A checkout on main with a bare origin, declaring `ci.green` from runs and listing BOT as the runner `ci-bot`. */
function workspace(green: Record<string, unknown> = GREEN): { root: string; origin: string } {
  const origin = scratchDir("chant-ci-runs-origin-");
  git(origin, "init", "-q", "--bare");
  const root = scratchDir("chant-ci-runs-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.com");
  writeFiles(root, {
    "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], { ci: { green } }),
    ".chant/trust.json": JSON.stringify({ schema: 1, runners: [{ principal: "ci-bot", class: "runner", key: BOT.ssh }], roles: { runner: ["ci-bot"] } }),
    "app/a.txt": "a\n",
  });
  git(root, "remote", "add", "origin", origin);
  commitAt(root, 23, "app/init.txt");
  return { root, origin };
}

const op = (name: string): OpConfig => ({ name, overview: `run ${name}`, labels: { Env: "ci" }, phases: [{ name: "Run", steps: [{ kind: "activity", fn: "step", args: {} }] }] });
const PASS = new Map<string, ActivityFn>([["step", async () => ({})]]);
const FAIL = new Map<string, ActivityFn>([
  [
    "step",
    async () => {
      throw new Error("red");
    },
  ],
]);

/** Run Op `name` at the checkout's HEAD, recording on its ledger, signed with `pem` when given. */
async function runOp(root: string, name: string, opts: { pem?: string; fail?: boolean } = {}): Promise<OpRunRecord> {
  const options = { cwd: root, ledger: { cwd: root }, ...(opts.pem ? { signRecord: opRunSigner(root, opts.pem) } : {}) };
  try {
    return (await runOpLocally(op(name), opts.fail ? FAIL : PASS, {}, undefined, options)).record;
  } catch (err) {
    if (err instanceof OpRunFailure) return err.result.record;
    throw err;
  }
}

/** Push main and the run ledger, as a CI job does after its runs. */
function push(root: string): void {
  git(root, "push", "-q", "origin", "main");
  git(root, "push", "-q", "origin", "chant/lifecycle");
}

const recordOf = (root: string, tag: string) => {
  const note = git(root, "tag", "-l", "--format=%(contents)", tag);
  return JSON.parse(note.slice(note.indexOf("{"))) as Record<string, unknown>;
};

describe("chant runs as the ci tick's status source (#4044)", () => {
  const readList = contract(listSchema);

  test("a commit is tagged green from signed local Op runs, and the tag names and carries them", async () => {
    const { root } = workspace();
    const a = commitAt(root, 3, "app/a.txt");
    const lint = await runOp(root, "lint", { pem: BOT.pem });
    const test1 = await runOp(root, "test", { pem: BOT.pem });
    expect(lint.gitSha).toBe(a);
    expect(lint.statement).toBeDefined();
    // The ledger holds the signed record, and it verifies there.
    const stored = (await readRunLedger("ci", "test", { cwd: root })).records[0]!;
    expect(stored.statement).toEqual(test1.statement);
    expect(verifyOpRunStatement(stored, RUNNERS, { runner: ["ci-bot"] })).toMatchObject({ status: "signed", signer: "ci-bot" });
    push(root);

    // No forge is given: a tick from runs needs none.
    const tick = await ciTick({ cwd: root, now: NOW, runnerKey: BOT.pem });
    expect(tick.source).toBe("runs");
    expect(tick.made).toEqual([`ci/green/${a}`]);
    expect(tick.signer).toBe("ci-bot");
    expect(formatTick(tick)).toContain("judged from chant runs");

    const record = recordOf(root, `ci/green/${a}`);
    expect(record.source).toBe("runs");
    const phases = record.phases as Record<string, { name: string; id: null; opRun: { id: string; env: string; signer: string; statement: unknown } }[]>;
    expect(phases.lint![0]).toMatchObject({ name: "lint", id: null, conclusion: "success", opRun: { id: lint.id, env: "ci", signer: "ci-bot" } });
    expect(phases.test![0]!.opRun.id).toBe(test1.id);
    expect(phases.test![0]!.opRun.statement).toEqual(test1.statement);
    expect(verifyCiTagStatement(record, { sha: a, kind: "green", branch: "main" }, RUNNERS, { runner: ["ci-bot"] })).toMatchObject({ status: "signed" });

    // The tag is pushed, and ci list reads it.
    expect(git(scratchDir("chant-ci-runs-peek-"), "ls-remote", "--tags", git(root, "remote", "get-url", "origin"))).toContain(`refs/tags/ci/green/${a}`);
    const list = await ciList({ cwd: root, now: NOW });
    readList.expectValid(list);
    const at = (list as Extract<typeof list, { commits: unknown }>).commits.find((c) => c.sha === a)!;
    expect(at.state).toBe("green");
    expect(at.phases[0]).toMatchObject({ phase: "lint", result: "pass", runs: [{ name: "lint", id: null, opRun: { id: lint.id, env: "ci", signer: "ci-bot" } }] });
    expect(at.ignoredRuns).toEqual([]);

    // A second tick over the same runs changes nothing.
    expect((await ciTick({ cwd: root, now: NOW, runnerKey: BOT.pem })).made).toEqual([]);
  });

  test("an unsigned run is refused: it neither greens nor revokes a commit, and is reported", async () => {
    const { root } = workspace();
    const a = commitAt(root, 3, "app/a.txt");
    await runOp(root, "lint", { pem: BOT.pem });
    const unsigned = await runOp(root, "test");
    expect(unsigned.statement).toBeUndefined();
    push(root);

    const tick = await ciTick({ cwd: root, now: NOW, runnerKey: BOT.pem });
    expect(tick.made).toEqual([]);
    const at = tick.commits.find((c) => c.sha === a)!;
    expect(at.verdict?.verdict).toBe("pending");
    expect(at.ignoredRuns).toEqual([{ run: unsigned.id, op: "test", env: "ci", status: "unsigned", reason: expect.stringContaining("carries no statement signed by a runner key") }]);
    expect(formatTick(tick)).toContain(`ignored run ${unsigned.id} of test in ci (unsigned)`);
    expect(git(root, "tag", "-l")).toBe("");

    const list = (await ciList({ cwd: root, now: NOW })) as Extract<Awaited<ReturnType<typeof ciList>>, { commits: unknown }>;
    readList.expectValid(list);
    const listed = list.commits.find((c) => c.sha === a)!;
    expect(listed.phases.map((p) => [p.phase, p.result])).toEqual([
      ["lint", "pass"],
      ["test", "pending"],
    ]);
    expect(listed.ignoredRuns?.map((r) => r.status)).toEqual(["unsigned"]);
    expect(formatList(list)).toContain(`ignored run ${unsigned.id} of test in ci (unsigned)`);

    // Signed now, the commit goes green; a later unsigned failure does not revoke it.
    await runOp(root, "test", { pem: BOT.pem });
    push(root);
    expect((await ciTick({ cwd: root, now: NOW, runnerKey: BOT.pem })).made).toEqual([`ci/green/${a}`]);
    await runOp(root, "test", { fail: true });
    push(root);
    const after = await ciTick({ cwd: root, now: NOW, runnerKey: BOT.pem });
    expect(after.made).toEqual([]);
    expect(after.commits.find((c) => c.sha === a)!.ignoredRuns?.map((r) => r.status)).toEqual(["unsigned", "unsigned"]);
  });

  test("a run signed by an unlisted key, or whose record changed after signing, does not count", async () => {
    const { root } = workspace();
    const a = commitAt(root, 3, "app/a.txt");
    // A key trust.json does not list can't sign a run here at all.
    const mallory = runnerKey();
    expect(() => opRunSigner(root, mallory.pem)).toThrow(/lists no runner with this key/);
    // A signed record whose outcome is edited before it reaches the ledger.
    const signed = await runOp(root, "lint", { pem: BOT.pem });
    const { version: _v, ...input } = { ...signed, status: "ok" as const, outcomes: { edited: true } };
    await appendRunRecord({ ...input, id: "tampered" }, { cwd: root });
    const source = await readOpRunSource(root, root, git(root, "rev-parse", "HEAD"));
    expect(source.checkRuns(a).map((r) => r.opRun!.id)).toEqual([signed.id]);
    expect(source.ignored.get(a)).toEqual([{ run: "tampered", op: "lint", env: "ci", status: "mismatch", reason: expect.stringContaining("does not match its record") }]);
  });

  test("a signed failing run revokes a green commit, and the revoked tag names the run", async () => {
    const { root } = workspace();
    const a = commitAt(root, 3, "app/a.txt");
    await runOp(root, "lint", { pem: BOT.pem });
    await runOp(root, "test", { pem: BOT.pem });
    push(root);
    expect((await ciTick({ cwd: root, now: NOW, runnerKey: BOT.pem })).made).toEqual([`ci/green/${a}`]);

    const red = await runOp(root, "test", { pem: BOT.pem, fail: true });
    expect(red.status).toBe("fail");
    push(root);
    const tick = await ciTick({ cwd: root, now: NOW, runnerKey: BOT.pem });
    expect(tick.made).toEqual([`ci/revoked/${a}`]);
    expect(formatTick(tick)).toContain("phase test, test failure");
    const record = recordOf(root, `ci/revoked/${a}`);
    expect(record).toMatchObject({ source: "runs", phase: "test", run: { name: "test", id: null, conclusion: "failure", opRun: { id: red.id, signer: "ci-bot" } } });
  });

  test("a tick from runs needs a runner key unless it is a dry run, --source overrides the declaration, and ci list refuses --forge", async () => {
    const { root } = workspace({ ...GREEN, source: "checks" });
    const a = commitAt(root, 3, "app/a.txt");
    await runOp(root, "lint", { pem: BOT.pem });
    await runOp(root, "test", { pem: BOT.pem });
    push(root);
    await expect(ciTick({ cwd: root, now: NOW, source: "runs" })).rejects.toThrow(/every tag it makes from them is signed by a runner key, and none was given/);
    expect((await ciTick({ cwd: root, now: NOW, source: "runs", dryRun: true })).made).toEqual([`ci/green/${a}`]);
    expect(git(root, "tag", "-l")).toBe("");
    // The declaration says checks, so without --source the tick wants a forge.
    await expect(ciTick({ cwd: root, now: NOW, runnerKey: BOT.pem })).rejects.toThrow(/needs a forge/);
    await expect(ciList({ cwd: root, now: NOW, source: "runs", forge: { kind: "github", checkRuns: async () => [] } })).rejects.toThrow(/--forge reads check runs, and the source is chant runs/);
    const list = (await ciList({ cwd: root, now: NOW, source: "runs" })) as Extract<Awaited<ReturnType<typeof ciList>>, { commits: unknown }>;
    expect(list.commits.find((c) => c.sha === a)!.phases.map((p) => p.result)).toEqual(["pass", "pass"]);
  });

  test("GitLab and Forgejo get no check-run reader, and the refusal points at chant runs", () => {
    expect(() => ciForgeFromEnv("gitlab", {})).toThrow(/sets ci.green.source to "runs"/);
    expect(() => ciForgeFromEnv("forgejo", {})).toThrow(/--source runs/);
  });
});
