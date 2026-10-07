/**
 * #3573 (ws-103) — which commits passed CI: the `ci.green` block, judging a
 * phase from check runs, the tick against a real git remote with a fake
 * forge, and `ci last-green` with its read-contract document.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { parseDeclaration, type CiPhase } from "./declaration";
import { cleanScratch, contract, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { ciTick, pushRefusalCause, evaluateCommit, evaluatePhase, latestAttempts, lastGreen, matchesCheckRun, windowMs, type LastGreenDocument } from "./ci-green";
import type { CheckRun, CiForge } from "./ci-green-forge";
import { runCiLastGreen } from "./ci-green-cli";
import lastGreenSchema from "./ci-last-green.schema.json";
import lsSchema from "./ls.schema.json";
import { listWorkspace, type LsDocument } from "./ls";
import type { CommandContext } from "../cli/registry";

afterAll(cleanScratch);

const GREEN = {
  branch: "main",
  phases: {
    lint: ["lint"],
    test: ["test", "e2e (*)"],
    macos: { runs: ["macos (test)"], skipped: "pass" },
  },
  require: ["lint", "test", "macos"],
};

const decl = (ci: unknown) => JSON.stringify({ name: "w", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "x" }], ci });

describe("the ci.green block (#3573)", () => {
  test("parses both phase forms with their defaults, in file order", () => {
    const d = parseDeclaration(decl({ green: GREEN }), "chant.workspace.json");
    expect(d.ci!.green).toEqual({
      branch: "main",
      window: "24h",
      phases: [
        { name: "lint", runs: ["lint"], skipped: "fail", pointer: "/ci/green/phases/lint" },
        { name: "test", runs: ["test", "e2e (*)"], skipped: "fail", pointer: "/ci/green/phases/test" },
        { name: "macos", runs: ["macos (test)"], skipped: "pass", pointer: "/ci/green/phases/macos" },
      ],
      require: ["lint", "test", "macos"],
      pointer: "/ci/green",
    });
    expect(parseDeclaration(decl({ green: { ...GREEN, window: "90m" } }), "chant.workspace.json").ci!.green!.window).toBe("90m");
    expect(parseDeclaration(decl({}), "chant.workspace.json").ci).toEqual({ green: null });
    expect(parseDeclaration(JSON.stringify({ name: "w", schema: 1, members: [] }), "chant.workspace.json").ci).toBeNull();
  });

  test("refuses a required phase it does not declare, and what the schema doesn't allow", () => {
    expect(() => parseDeclaration(decl({ green: { ...GREEN, require: ["lint", "docs"] } }), "chant.workspace.json")).toThrow(/require names the phase "docs"/);
    for (const bad of [
      { ...GREEN, window: "soon" },
      { ...GREEN, window: "10s" },
      { ...GREEN, phases: { lint: [] } },
      { ...GREEN, phases: { lint: { runs: ["lint"], skipped: "maybe" } } },
      { ...GREEN, require: [] },
      { phases: GREEN.phases, require: GREEN.require },
      { ...GREEN, branch: "has space" },
    ]) {
      expect(() => parseDeclaration(decl({ green: bad }), "chant.workspace.json"), JSON.stringify(bad)).toThrow();
    }
  });
});

// ── Judging check runs ───────────────────────────────────────────────────────

const run = (id: number, name: string, conclusion: string | null, status = "completed"): CheckRun => ({
  id,
  name,
  status,
  conclusion: status === "completed" ? conclusion : null,
  completedAt: null,
  url: `https://github.com/acme/app/runs/${id}`,
});
const phase = (runs: string[], skipped: "pass" | "fail" = "fail"): CiPhase => ({ name: "p", runs, skipped, pointer: "/p" });

describe("judging a phase from check runs (#3573)", () => {
  test("a pattern matches a whole name, * standing for any run of characters", () => {
    expect(matchesCheckRun("e2e (*)", "e2e (chromium)")).toBe(true);
    expect(matchesCheckRun("e2e (*)", "e2e")).toBe(false);
    expect(matchesCheckRun("test", "test-shard (1/4)")).toBe(false);
    expect(matchesCheckRun("test*", "test-shard (1/4)")).toBe(true);
    expect(matchesCheckRun("a.b", "axb")).toBe(false);
  });

  test("each run is judged by its latest attempt", () => {
    expect(latestAttempts([run(1, "test", "failure"), run(5, "test", "success"), run(3, "test", "failure")]).map((r) => r.id)).toEqual([5]);
    expect(evaluatePhase(phase(["test"]), latestAttempts([run(1, "test", "failure"), run(2, "test", "success")])).verdict).toBe("pass");
    expect(evaluatePhase(phase(["test"]), latestAttempts([run(1, "test", "success"), run(2, "test", "failure")])).verdict).toBe("fail");
    // A re-run still going leaves the phase undecided, whatever the attempt before it said.
    expect(evaluatePhase(phase(["test"]), latestAttempts([run(1, "test", "success"), run(2, "test", null, "in_progress")])).verdict).toBe("pending");
  });

  test("every run a pattern matches must pass", () => {
    const runs = [run(1, "e2e (chromium)", "success"), run(2, "e2e (webkit)", "failure")];
    const v = evaluatePhase(phase(["e2e (*)"]), runs);
    expect(v.verdict).toBe("fail");
    expect(v.runs.map((r) => [r.name, r.verdict])).toEqual([
      ["e2e (chromium)", "pass"],
      ["e2e (webkit)", "fail"],
    ]);
  });

  test("a skipped run passes only under skipped: pass", () => {
    const runs = [run(1, "macos (test)", "skipped")];
    expect(evaluatePhase(phase(["macos (test)"]), runs).verdict).toBe("fail");
    expect(evaluatePhase(phase(["macos (test)"], "pass"), runs).verdict).toBe("pass");
    // Neither counts any other conclusion as a pass.
    for (const c of ["neutral", "cancelled", "timed_out", "action_required", "stale"]) {
      expect(evaluatePhase(phase(["x"], "pass"), [run(1, "x", c)]).verdict, c).toBe("fail");
    }
  });

  test("a run in progress, or a pattern nothing matches yet, leaves the phase undecided; a failure decides it", () => {
    expect(evaluatePhase(phase(["lint"]), [run(1, "lint", null, "queued")]).verdict).toBe("pending");
    const missing = evaluatePhase(phase(["lint", "build"]), [run(1, "lint", "success")]);
    expect(missing).toMatchObject({ verdict: "pending", unmatched: ["build"] });
    expect(evaluatePhase(phase(["lint", "build"]), [run(1, "lint", "failure")]).verdict).toBe("fail");
  });

  test("a commit fails on its first failing required phase, and passes when every one passes", () => {
    const green = parseDeclaration(decl({ green: GREEN }), "chant.workspace.json").ci!.green!;
    const all = [run(1, "lint", "success"), run(2, "test", "success"), run(3, "e2e (a)", "success"), run(4, "macos (test)", "skipped")];
    expect(evaluateCommit(green, all).verdict).toBe("pass");
    const red = evaluateCommit(green, [...all, run(9, "test", "failure")]);
    expect(red.verdict).toBe("fail");
    expect(red.failure).toMatchObject({ phase: "test", run: { name: "test", id: 9, conclusion: "failure" } });
    expect(evaluateCommit(green, all.slice(1)).verdict).toBe("pending");
  });

  test("the window is minutes, hours or days", () => {
    expect(windowMs("24h")).toBe(86_400_000);
    expect(windowMs("90m")).toBe(5_400_000);
    expect(windowMs("7d")).toBe(604_800_000);
    expect(() => windowMs("1w")).toThrow();
  });
});

// ── The tick, against a real remote ──────────────────────────────────────────

const NOW = new Date("2026-10-06T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/** git with a fixed author and committer time. */
function gitAt(cwd: string, date: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
}

function commitAt(root: string, hours: number, file: string): string {
  writeFiles(root, { [file]: `${file} ${hours}\n` });
  gitAt(root, hoursAgo(hours), "add", "-A");
  gitAt(root, hoursAgo(hours), "commit", "-q", "-m", file);
  return git(root, "rev-parse", "HEAD");
}

/** A checkout on main whose origin is a bare repository, declaring `ci.green`. */
function workspace(green: unknown = GREEN): { root: string; origin: string } {
  const origin = scratchDir("chant-ci-origin-");
  git(origin, "init", "-q", "--bare");
  const root = scratchDir("chant-ci-work-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFiles(root, { "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], { ci: { green } }), "app/a.txt": "a\n" });
  git(root, "remote", "add", "origin", origin);
  return { root, origin };
}

const push = (root: string) => git(root, "push", "-q", "origin", "main");
const remoteTags = (origin: string) => git(origin, "for-each-ref", "--format=%(refname:lstrip=2)", "refs/tags/").split("\n").filter(Boolean).sort();

const PASSING = [run(1, "lint", "success"), run(2, "test", "success"), run(3, "e2e (chromium)", "success"), run(4, "macos (test)", "skipped")];

/** A forge whose check runs a test sets per commit, counting what it is asked. */
function fakeForge(runs: Map<string, CheckRun[]>): CiForge & { asked: string[] } {
  const asked: string[] = [];
  return { kind: "github", asked, checkRuns: async (sha) => (asked.push(sha), runs.get(sha) ?? []) };
}

describe("chant ci tick (#3573)", () => {
  test("tags green once, revokes once, and a second tick changes nothing", async () => {
    const { root, origin } = workspace();
    const a = commitAt(root, 5, "app/a.txt");
    const b = commitAt(root, 3, "app/b.txt");
    const c = commitAt(root, 1, "app/c.txt");
    push(root);
    const runs = new Map([
      [a, PASSING],
      [b, [...PASSING.slice(0, 3), run(7, "test", null, "in_progress")]],
      [c, [run(1, "lint", "failure")]],
    ]);
    const forge = fakeForge(runs);

    const first = await ciTick({ cwd: root, forge, now: NOW });
    expect(first.made).toEqual([`ci/green/${a}`]);
    expect(first.commits.map((x) => [x.sha, x.verdict?.verdict])).toEqual([
      [c, "fail"],
      [b, "pending"],
      [a, "pass"],
    ]);
    expect(remoteTags(origin)).toEqual([`ci/green/${a}`]);
    // Annotated, with the time and each required phase's runs.
    expect(git(origin, "cat-file", "-t", `refs/tags/ci/green/${a}`)).toBe("tag");
    const note = git(origin, "tag", "-l", "--format=%(contents)", `ci/green/${a}`);
    const record = JSON.parse(note.slice(note.indexOf("{")));
    expect(record).toMatchObject({ tag: "green", commit: a, branch: "main", at: "2026-10-06T12:00:00Z" });
    expect(Object.keys(record.phases)).toEqual(["lint", "test", "macos"]);
    expect(record.phases.test.map((r: { name: string }) => r.name)).toEqual(["test", "e2e (chromium)"]);

    const again = await ciTick({ cwd: root, forge, now: NOW });
    expect(again.made).toEqual([]);
    expect(remoteTags(origin)).toEqual([`ci/green/${a}`]);

    // A re-run of a's tests goes red: a is revoked, once.
    runs.set(a, [...PASSING, run(9, "test", "failure")]);
    const revoke = await ciTick({ cwd: root, forge, now: NOW });
    expect(revoke.made).toEqual([`ci/revoked/${a}`]);
    const why = git(origin, "tag", "-l", "--format=%(contents)", `ci/revoked/${a}`);
    expect(JSON.parse(why.slice(why.indexOf("{")))).toMatchObject({ tag: "revoked", commit: a, phase: "test", run: { name: "test", id: 9, conclusion: "failure" } });
    expect((await ciTick({ cwd: root, forge, now: NOW })).made).toEqual([]);

    // Passing again does not make it green again by itself, and the forge is not asked about it.
    runs.set(a, [...PASSING, run(9, "test", "failure"), run(10, "test", "success")]);
    forge.asked.length = 0;
    expect((await ciTick({ cwd: root, forge, now: NOW })).made).toEqual([]);
    expect(forge.asked).not.toContain(a);
    expect(remoteTags(origin)).toEqual([`ci/green/${a}`, `ci/revoked/${a}`]);
    expect((lastGreen({ cwd: root }) as { commit: unknown }).commit).toBeNull();
  });

  test("deleting the revoked tag by hand makes the commit count as green again", async () => {
    const { root, origin } = workspace();
    const a = commitAt(root, 2, "app/a.txt");
    push(root);
    const runs = new Map([[a, PASSING]]);
    await ciTick({ cwd: root, forge: fakeForge(runs), now: NOW });
    runs.set(a, [...PASSING, run(9, "lint", "failure")]);
    await ciTick({ cwd: root, forge: fakeForge(runs), now: NOW });
    expect(remoteTags(origin)).toEqual([`ci/green/${a}`, `ci/revoked/${a}`]);

    // Someone fixes the flake and deletes the revoked tag on the remote.
    runs.set(a, [...PASSING, run(9, "lint", "failure"), run(11, "lint", "success")]);
    git(root, "push", "-q", "origin", `:refs/tags/ci/revoked/${a}`);
    const tick = await ciTick({ cwd: root, forge: fakeForge(runs), now: NOW });
    expect(tick.made).toEqual([]);
    expect(tick.commits[0]).toMatchObject({ sha: a, before: "green" });
    // The fetch pruned the local copy, so the read sees it green again.
    expect((lastGreen({ cwd: root }) as { commit: { sha: string } }).commit.sha).toBe(a);
  });

  test("looks only at first-parent commits within the window", async () => {
    const { root, origin } = workspace({ ...GREEN, window: "6h" });
    const old = commitAt(root, 30, "app/old.txt");
    const base = commitAt(root, 4, "app/base.txt");
    git(root, "checkout", "-q", "-b", "side");
    const side = commitAt(root, 3, "app/side.txt");
    git(root, "checkout", "-q", "main");
    gitAt(root, hoursAgo(2), "merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = git(root, "rev-parse", "HEAD");
    push(root);
    const forge = fakeForge(new Map([old, base, side, merge].map((s) => [s, PASSING])));
    const tick = await ciTick({ cwd: root, forge, now: NOW });
    expect(tick.commits.map((c) => c.sha)).toEqual([merge, base]);
    expect(forge.asked.sort()).toEqual([merge, base].sort());
    expect(remoteTags(origin)).toEqual([`ci/green/${base}`, `ci/green/${merge}`].sort());
  });

  test("a dry run decides and makes no tag", async () => {
    const { root, origin } = workspace();
    const a = commitAt(root, 1, "app/a.txt");
    push(root);
    const tick = await ciTick({ cwd: root, forge: fakeForge(new Map([[a, PASSING]])), now: NOW, dryRun: true });
    expect(tick.made).toEqual([`ci/green/${a}`]);
    expect(remoteTags(origin)).toEqual([]);
    expect(git(root, "tag", "-l")).toBe("");
  });

  test("a push GitHub refuses for lack of the workflows permission names the cause and the flags that fix it", async () => {
    const { root, origin } = workspace();
    const a = commitAt(root, 1, "app/a.txt");
    push(root);
    // The bare origin refuses tags the way GitHub does when the tagged commit changes a workflow file.
    const hook = join(origin, "hooks", "pre-receive");
    writeFileSync(
      hook,
      "#!/bin/sh\necho 'refusing to allow a GitHub App to create or update workflow `.github/workflows/check.yml` without `workflows` permission' >&2\nexit 1\n",
    );
    chmodSync(hook, 0o755);
    const tick = ciTick({ cwd: root, forge: fakeForge(new Map([[a, PASSING]])), now: NOW });
    await expect(tick).rejects.toThrow(/could not push ci\/green\/[0-9a-f]+ to origin: GitHub refused the tag push because the tagged commit changes workflow files, and GITHUB_TOKEN can't update workflows: regenerate the workflow with --token-secret <NAME>/);
    await expect(ciTick({ cwd: root, forge: fakeForge(new Map([[a, PASSING]])), now: NOW })).rejects.toThrow(/without `workflows` permission/);
    expect(remoteTags(origin)).toEqual([]);
  });

  test("other push refusals get no workflows hint", () => {
    expect(pushRefusalCause("! [remote rejected] ci/green/abc -> ci/green/abc (refusing to allow a GitHub App to create or update workflow .github/workflows/check.yml without workflows permission)")).toMatch(/--token-secret/);
    expect(pushRefusalCause("refusing to allow an OAuth App to create or update workflow `.github/workflows/x.yml` without `workflow` scope")).toMatch(/--app-id-var/);
    expect(pushRefusalCause("! [rejected] ci/green/abc -> ci/green/abc (already exists)")).toBeNull();
    expect(pushRefusalCause("remote: Permission to o/r.git denied to github-actions[bot].")).toBeNull();
  });
});

// ── last-green ───────────────────────────────────────────────────────────────

const read = contract(lastGreenSchema);

function captured(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((s: unknown) => void out.push(String(s)));
  const error = vi.spyOn(console, "error").mockImplementation((s: unknown) => void err.push(String(s)));
  return fn()
    .then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }))
    .finally(() => {
      log.mockRestore();
      error.mockRestore();
    });
}

const ctx = (json: boolean) => ({ args: { json } }) as unknown as CommandContext;

describe("chant ci last-green (#3573)", () => {
  test("prints the newest green commit that is not revoked, as text and as the read contract's document", async () => {
    const { root } = workspace();
    const a = commitAt(root, 4, "app/a.txt");
    const b = commitAt(root, 3, "app/b.txt");
    const c = commitAt(root, 2, "app/c.txt");
    commitAt(root, 1, "app/d.txt");
    push(root);
    const runs = new Map([
      [a, PASSING],
      [b, PASSING],
      [c, PASSING],
    ]);
    await ciTick({ cwd: root, forge: fakeForge(runs), now: NOW });
    runs.set(c, [run(9, "lint", "failure")]);
    await ciTick({ cwd: root, forge: fakeForge(runs), now: NOW });

    const doc = lastGreen({ cwd: root }) as Extract<LastGreenDocument, { branch: string }>;
    read.expectValid(doc);
    expect(doc).toMatchObject({ contract: 1, workspace: { name: "acme", root: ".", file: "chant.workspace.json" }, branch: "main", ref: "refs/remotes/origin/main" });
    expect(doc.commit).toMatchObject({ sha: b, tag: `ci/green/${b}` });
    expect(doc.commit!.tagged).toMatch(/^\d{4}-\d\d-\d\dT/);

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      expect(await captured(() => runCiLastGreen(ctx(false)))).toMatchObject({ code: 0, out: b });
      const json = await captured(() => runCiLastGreen(ctx(true)));
      expect(json.code).toBe(0);
      expect(JSON.parse(json.out)).toEqual(doc);
    } finally {
      cwd.mockRestore();
    }
  });

  test("no green commit is a result with a null commit; no ci.green is a failure", async () => {
    const { root } = workspace();
    commitAt(root, 1, "app/a.txt");
    const none = lastGreen({ cwd: root });
    read.expectValid(none);
    expect(none).toMatchObject({ ref: "refs/heads/main", commit: null });

    const plain = scratchDir("chant-ci-plain-");
    git(plain, "init", "-q");
    writeFiles(plain, { "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "x" }]), "app/a.txt": "a\n" });
    const undeclared = lastGreen({ cwd: plain });
    read.expectValid(undeclared);
    expect(undeclared).toMatchObject({ error: { code: "ci-green-undeclared" } });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(plain);
    try {
      expect((await captured(() => runCiLastGreen(ctx(true)))).code).toBe(1);
    } finally {
      cwd.mockRestore();
    }
  });

  test("ls --json serves the block with its defaults", () => {
    const { root } = workspace();
    const doc = listWorkspace({ cwd: root });
    contract(lsSchema).expectValid(doc);
    expect((doc as Extract<LsDocument, { ci: unknown }>).ci!.green).toEqual({
      branch: "main",
      window: "24h",
      phases: [
        { name: "lint", runs: ["lint"], skipped: "fail" },
        { name: "test", runs: ["test", "e2e (*)"], skipped: "fail" },
        { name: "macos", runs: ["macos (test)"], skipped: "pass" },
      ],
      require: ["lint", "test", "macos"],
    });
  });
});
