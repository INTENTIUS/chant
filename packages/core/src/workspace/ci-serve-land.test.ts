/**
 * #4168 4.4 — `ci serve --land` fast-forwards the target to a pushed
 * `chant/land/<name>` branch once its pre-merge phases pass on it, and
 * #4016 gap 6 — `ci serve --forge git` reads a plain git server's refs.
 *
 * Each test works in its own clone with a bare origin. The build and the
 * judge are fakes; `ci-serve-land.e2e.test.ts` runs the real ones.
 */

import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { ciServeLands, formatCiServeEvent, gitCiServeForge, newCiServeRuntime, readCiServeState, type CiServeEvent, type CiServeOptions } from "./ci-serve";
import type { CommitVerdict } from "./ci-green";

afterAll(cleanScratch);

function commit(root: string, file: string): string {
  writeFiles(root, { [file]: `${file}\n` });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", file);
  return git(root, "rev-parse", "HEAD");
}

/** A clone on main with a bare origin. */
function clone(): { root: string; origin: string; main: string } {
  const origin = scratchDir("chant-serve-land-origin-");
  git(origin, "init", "-q", "--bare");
  const root = scratchDir("chant-serve-land-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.com");
  git(root, "remote", "add", "origin", origin);
  const main = commit(root, "a.txt");
  git(root, "push", "-q", "origin", "main");
  return { root, origin, main };
}

/** A commit on top of `from`, pushed as `chant/land/<name>`. */
function pushLand(root: string, name: string, from: string, file: string): string {
  git(root, "checkout", "-q", "--detach", from);
  const sha = commit(root, file);
  git(root, "push", "-q", "--force", "origin", `${sha}:refs/heads/chant/land/${name}`);
  git(root, "checkout", "-q", "main");
  return sha;
}

const verdict = (phases: Record<string, "pass" | "fail" | "pending">): CommitVerdict => {
  const list = Object.entries(phases).map(([phase, v]) => ({ phase, verdict: v, runs: [], unmatched: [] }));
  return { verdict: list.some((p) => p.verdict === "fail") ? "fail" : list.some((p) => p.verdict === "pending") ? "pending" : "pass", phases: list, failure: null };
};

function options(root: string, log: CiServeEvent[], extra: Partial<CiServeOptions> = {}): CiServeOptions & { built: { commit: string; phases: string[]; reason: string }[] } {
  const built: { commit: string; phases: string[]; reason: string }[] = [];
  return {
    cwd: root,
    forge: "git",
    repo: "origin",
    env: "prod",
    client: gitCiServeForge(root),
    stateDir: join(root, ".git", "serve"),
    buildCommand: "true",
    build: async ({ request }) => (built.push({ ...request }), 0),
    land: { phases: ["check"] },
    judgeLand: async () => verdict({ check: "pass" }),
    log: (e) => log.push(e),
    built,
    ...extra,
  };
}

const remoteHead = (origin: string, ref: string): string | undefined => {
  try {
    return git(origin, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return undefined;
  }
};

describe("the git forge kind (#4016 gap 6)", () => {
  test("reads the branch head through ls-remote, lists no pull requests, and says when the branch is missing", async () => {
    const { root, main } = clone();
    const forge = gitCiServeForge(root);
    expect(await forge.branchHead("main")).toBe(main);
    expect(await forge.branchHead("nope")).toBeUndefined();
    expect(await forge.openPullRequests("main")).toEqual([]);
    expect(forge.pullRequestFor).toBeUndefined();
  });
});

describe("ci serve --land (#4168 4.4)", () => {
  test("a land whose pre-merge phases pass moves the target to it and deletes the land branch, once", async () => {
    const { root, origin, main } = clone();
    const head = pushLand(root, "fix", main, "b.txt");
    const log: CiServeEvent[] = [];
    const opts = options(root, log);
    const rt = newCiServeRuntime();
    const pass = await ciServeLands(opts, rt);
    await Promise.all(pass.started);

    expect(opts.built).toEqual([{ commit: head, phases: ["check"], reason: "land" }]);
    expect(remoteHead(origin, "refs/heads/main")).toBe(head);
    expect(remoteHead(origin, "refs/heads/chant/land/fix")).toBeUndefined();
    const state = readCiServeState(join(root, ".git", "serve", "chant-apply-prod.json"), { forge: "git", repo: "origin", env: "prod", branch: "main" });
    expect(state.lands?.[`land:fix:${head}`]).toMatchObject({ branch: "chant/land/fix", commit: head, status: "landed" });
    expect(log.map(formatCiServeEvent)).toContain(`chant/land/fix at ${head.slice(0, 12)} landed, and the land branch was deleted`);

    // Nothing is left to serve.
    expect((await ciServeLands(opts, rt)).started).toEqual([]);
  });

  test("a red pre-merge phase refuses the land and leaves the target and the land branch", async () => {
    const { root, origin, main } = clone();
    const head = pushLand(root, "red", main, "b.txt");
    const log: CiServeEvent[] = [];
    const opts = options(root, log, { judgeLand: async () => verdict({ check: "fail" }) });
    await Promise.all((await ciServeLands(opts, newCiServeRuntime())).started);

    expect(remoteHead(origin, "refs/heads/main")).toBe(main);
    expect(remoteHead(origin, "refs/heads/chant/land/red")).toBe(head);
    expect(log.map(formatCiServeEvent)).toContain(`chant/land/red at ${head.slice(0, 12)} was refused and left on the remote: the pre-merge phase check failed`);
  });

  test("a phase with no finished run, or a build that fails, refuses the land", async () => {
    const { root, origin, main } = clone();
    const a = pushLand(root, "norun", main, "b.txt");
    const b = pushLand(root, "broken", main, "c.txt");
    const log: CiServeEvent[] = [];
    const opts = options(root, log, {
      maxJobs: 2,
      judgeLand: async () => verdict({ check: "pending" }),
      build: async ({ request }) => (request.commit === b ? 3 : 0),
    });
    await Promise.all((await ciServeLands(opts, newCiServeRuntime())).started);

    expect(remoteHead(origin, "refs/heads/main")).toBe(main);
    const lines = log.map(formatCiServeEvent);
    expect(lines).toContain(`chant/land/norun at ${a.slice(0, 12)} was refused and left on the remote: the build recorded no finished run for check`);
    expect(lines).toContain(`chant/land/broken at ${b.slice(0, 12)} was refused and left on the remote: the build of check exited 3`);
  });

  test("a land that does not descend from the target is refused without a build, and a new push to it is tried again", async () => {
    const { root, origin, main } = clone();
    const stale = pushLand(root, "old", main, "b.txt");
    const moved = commit(root, "c.txt");
    git(root, "push", "-q", "origin", "main");
    const log: CiServeEvent[] = [];
    const opts = options(root, log);
    const rt = newCiServeRuntime();
    await Promise.all((await ciServeLands(opts, rt)).started);

    expect(opts.built).toEqual([]);
    expect(remoteHead(origin, "refs/heads/main")).toBe(moved);
    expect(log.map(formatCiServeEvent)).toContain(
      `chant/land/old at ${stale.slice(0, 12)} was refused and left on the remote: ${stale.slice(0, 12)} does not descend from main at ${moved.slice(0, 12)}; rebase chant/land/old onto it and push again`,
    );
    // The same head is not tried twice.
    expect((await ciServeLands(opts, rt)).started).toEqual([]);

    // Rebased and pushed again, it lands.
    const rebased = pushLand(root, "old", moved, "b.txt");
    await Promise.all((await ciServeLands(opts, rt)).started);
    expect(remoteHead(origin, "refs/heads/main")).toBe(rebased);
  });

  test("lands wait for capacity", async () => {
    const { root, main } = clone();
    const head = pushLand(root, "fix", main, "b.txt");
    const log: CiServeEvent[] = [];
    const rt = newCiServeRuntime();
    rt.inflight.set("busy", new Promise(() => {}));
    expect((await ciServeLands(options(root, log), rt)).started).toEqual([]);
    expect(log.map(formatCiServeEvent)).toContain(`chant/land/fix at ${head.slice(0, 12)} waits: --max-jobs jobs run`);
  });
});
