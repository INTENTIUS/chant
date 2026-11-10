/**
 * #4979: `chant lock --reach`, the targets a change reaches by the pipeline's
 * reach line, after the pull request's head is fetched and checked, and
 * GitLab's `--open` over every open merge request.
 */
import { describe, expect, test } from "vitest";
import { pullRequestHeadRef, REACH_HEAD_REF, reachedTargets, reachOpen, type ReachRun } from "./reach-locks";

const HEAD = "c".repeat(40);
const BASE = "b".repeat(40);

/** A run that answers git and the reach line as given, and keeps what it was asked. */
function runs(o: { fetch?: number; head?: string; out?: string; status?: number; stderr?: string } = {}) {
  const calls: Array<{ argv: string[]; env?: Record<string, string | undefined> }> = [];
  const run: ReachRun = (argv, opts) => {
    calls.push({ argv, ...(opts.env ? { env: opts.env } : {}) });
    if (argv[1] === "fetch") return { status: o.fetch ?? 0, stdout: "", stderr: o.fetch ? "fatal: couldn't find remote ref" : "" };
    if (argv[1] === "rev-parse") return { status: 0, stdout: `${o.head ?? HEAD}\n`, stderr: "" };
    return { status: o.status ?? 0, stdout: o.out ?? "", stderr: o.stderr ?? "" };
  };
  return { run, calls };
}

describe("reachedTargets (#4979)", () => {
  test("fetches the head, runs the line with BASE_SHA, HEAD_SHA and PR_NUMBER, and locks each name once, sorted", () => {
    const r = runs({ out: "envs/prod/app\n\nenvs/dev/network\n  envs/prod/app  \n" });
    expect(reachedTargets({ forge: "github", pr: 7, head: HEAD, base: BASE, line: "terragucci reached", env: { PATH: "/bin" }, run: r.run })).toEqual({ targets: ["envs/dev/network", "envs/prod/app"] });
    expect(r.calls[0]!.argv).toEqual(["git", "fetch", "-q", "--no-tags", "origin", `+refs/pull/7/head:${REACH_HEAD_REF}`]);
    expect(r.calls[2]!.argv).toEqual(["sh", "-c", "terragucci reached"]);
    expect(r.calls[2]!.env).toEqual({ PATH: "/bin", BASE_SHA: BASE, HEAD_SHA: HEAD, PR_NUMBER: "7" });
  });

  test("GitLab's head is the merge request's ref", () => {
    expect(pullRequestHeadRef("gitlab", 3)).toBe("refs/merge-requests/3/head");
    expect(pullRequestHeadRef("forgejo", 3)).toBe("refs/pull/3/head");
  });

  test("a head that moved is left to its own run, and nothing is read", () => {
    const r = runs({ head: "d".repeat(40) });
    expect(reachedTargets({ forge: "github", pr: 7, head: HEAD, base: BASE, line: "x", run: r.run })).toEqual({ moved: "pull request 7 moved to dddddddddddd after cccccccccccc, so the run of that push locks it" });
    expect(r.calls.map((c) => c.argv[0])).toEqual(["git", "git"]);
  });

  test("a fetch, a line that fails, or a name with a control character says why", () => {
    expect(reachedTargets({ forge: "gitlab", pr: 7, head: HEAD, base: BASE, line: "x", run: runs({ fetch: 128 }).run })).toEqual({ error: "could not fetch merge request !7's head (fatal: couldn't find remote ref)" });
    expect(reachedTargets({ forge: "github", pr: 7, head: HEAD, base: BASE, line: "x", run: runs({ status: 2, stderr: "no layers" }).run })).toEqual({ error: "the reach line exited 2: no layers" });
    expect(reachedTargets({ forge: "github", pr: 7, head: HEAD, base: BASE, line: "x", run: runs({ out: "a\u001b[31mb\n" }).run })).toMatchObject({ error: expect.stringMatching(/is not a target name/) });
    expect(reachedTargets({ forge: "github", pr: 7, head: "main", base: BASE, line: "x", run: runs().run })).toEqual({ error: '--head "main" is not a commit sha' });
    expect(reachedTargets({ forge: "github", pr: 7, head: HEAD, base: BASE, line: " ", run: runs().run })).toEqual({ error: "the reach line in CHANT_LOCK_REACH is empty" });
  });

  test("a change that reaches nothing locks nothing", () => {
    expect(reachedTargets({ forge: "github", pr: 7, head: HEAD, base: BASE, line: "x", run: runs({ out: "" }).run })).toEqual({ targets: [] });
  });
});

describe("reachOpen, GitLab's lock job (#4979)", () => {
  test("locks each open merge request from the project into the branch, skips a fork, and releases a closed holder's locks", async () => {
    const took: Array<[number, string, string[]]> = [];
    const released: number[] = [];
    const got = await reachOpen({
      forge: "gitlab",
      base: BASE,
      line: "x",
      branch: "main",
      run: runs({ out: "envs/dev\n" }).run,
      open: [
        { number: 1, headSha: HEAD, base: "main", fork: false },
        { number: 2, headSha: HEAD, base: "main", fork: true },
        { number: 3, headSha: HEAD, base: "release", fork: false },
        { number: 4, headSha: HEAD, base: "main", fork: false },
      ],
      take: async (pr, head, targets) => {
        took.push([pr, head, targets]);
        return pr === 4 ? { ok: false, held: "envs/dev is locked by merge request !1, so merge request !4 is not locked" } : { ok: true, released: [] };
      },
      holders: async () => [1, 5, 6],
      isOpen: async (pr) => pr === 6,
      release: async (pr) => (released.push(pr), ["envs/old"]),
    });
    expect(took).toEqual([[1, HEAD, ["envs/dev"]], [4, HEAD, ["envs/dev"]]]);
    expect(got.outcomes.map((o) => [o.pr, o.kind])).toEqual([[1, "locked"], [2, "skipped"], [3, "skipped"], [4, "held"]]);
    // !5 is closed; !6 is open into another branch, so it keeps its locks.
    expect(released).toEqual([5]);
    expect(got.released).toEqual([{ pr: 5, targets: ["envs/old"] }]);
  });
});
