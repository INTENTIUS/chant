/**
 * #4979: `chant lock --reach` end to end, in a clone of a bare remote that
 * holds a pull request's head at `refs/pull/<n>/head`: the head is fetched
 * and checked, the reach line reads the change from git, and what it prints
 * is locked on `chant/lifecycle` and pushed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { commandRegistry, parseArgs } from "../main";
import { resolveCommand } from "../registry";

const home = process.cwd();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A bare remote with main and pull request 7's head, which changes envs/dev, and a clone of main. */
function world(): { clone: string; remote: string; base: string; head: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-lock-reach-")));
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "test@chant.dev"], ["user.name", "Test"], ["commit.gpgsign", "false"]]) git(work, "config", k!, v!);
  mkdirSync(join(work, "envs", "dev"), { recursive: true });
  mkdirSync(join(work, "envs", "prod"), { recursive: true });
  writeFileSync(join(work, "envs", "dev", "main.tf"), "# dev\n");
  writeFileSync(join(work, "envs", "prod", "main.tf"), "# prod\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "init");
  const base = git(work, "rev-parse", "HEAD");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "origin", "main");
  writeFileSync(join(work, "envs", "dev", "main.tf"), "# dev, changed\n");
  git(work, "commit", "-q", "-am", "change dev");
  const head = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", "origin", `${head}:refs/pull/7/head`);
  const clone = join(root, "clone");
  git(root, "clone", "-q", remote, clone);
  for (const [k, v] of [["user.email", "test@chant.dev"], ["user.name", "Test"], ["commit.gpgsign", "false"]]) git(clone, "config", k!, v!);
  return { clone, remote, base, head };
}

async function run(argv: string[], env: Record<string, string>): Promise<{ code: number; err: string }> {
  let err = "";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation((s) => void (err += String(s) + "\n"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const args = parseArgs(argv);
    const match = resolveCommand(args, commandRegistry);
    const code = await match!.def.handler({ args, plugins: [], serializers: [] });
    return { code: code ?? 0, err };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  }
}

// The forge's API is a port nothing listens on: the status post is a warning, and no other holder needs asking.
const forgeEnv = { GITHUB_REPOSITORY: "acme/infra", GITHUB_TOKEN: "t", GITHUB_API_URL: "http://127.0.0.1:9", CHANT_LOCK_REACH: 'git diff --name-only "$BASE_SHA" "$HEAD_SHA" | cut -d/ -f1-2 | sort -u' };

afterEach(() => process.chdir(home));

describe("chant lock --reach (#4979)", () => {
  test("locks what the reach line prints for the pull request's head, and pushes chant/lifecycle", async () => {
    const w = world();
    process.chdir(w.clone);
    const got = await run(["lock", "--reach", "--pr", "7", "--head", w.head, "--base", w.base, "--stage", "plan", "--gate", "tf-apply", "--forge", "github"], forgeEnv);
    expect(got.err).toMatch(/pull request 7 holds envs\/dev on tf-apply/);
    expect(got.code).toBe(0);
    const locks = JSON.parse(git(w.remote, "show", "chant/lifecycle:_locks/tf-apply.json")) as { locks: Record<string, { pr: number; stage: string; head: string }> };
    expect(Object.keys(locks.locks)).toEqual(["envs/dev"]);
    expect(locks.locks["envs/dev"]).toMatchObject({ pr: 7, stage: "plan", head: w.head });
  });

  test("a head that moved since the job started locks nothing, and the job passes", async () => {
    const w = world();
    process.chdir(w.clone);
    const got = await run(["lock", "--reach", "--pr", "7", "--head", w.base, "--base", w.base, "--stage", "plan", "--forge", "github"], forgeEnv);
    expect(got.code).toBe(0);
    expect(got.err).toMatch(/pull request 7 moved to .*, so the run of that push locks it/);
  });

  test("is refused without the line, the forge, or the two commits", async () => {
    const w = world();
    process.chdir(w.clone);
    expect((await run(["lock", "--reach", "--pr", "7", "--head", w.head, "--base", w.base, "--forge", "github"], { ...forgeEnv, CHANT_LOCK_REACH: "" })).err).toMatch(/CHANT_LOCK_REACH, which is not set/);
    expect((await run(["lock", "--reach", "--pr", "7", "--head", w.head, "--base", w.base], forgeEnv)).err).toMatch(/give --forge github, gitlab or forgejo/);
    expect((await run(["lock", "--reach", "--pr", "7", "--head", w.head, "--forge", "github"], forgeEnv)).err).toMatch(/from --base <sha> to --head <sha>/);
    expect((await run(["lock", "--reach", "envs/dev", "--pr", "7", "--head", w.head, "--base", w.base, "--forge", "github"], forgeEnv)).err).toMatch(/drop the names/);
  });
});
