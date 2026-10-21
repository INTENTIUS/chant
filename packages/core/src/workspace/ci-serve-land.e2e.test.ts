/**
 * #4168 4.4 and #4016 gap 6 end to end: `chant ci serve --forge git --land`,
 * as a process, against a bare git remote with no forge API, no runner key
 * and no signers.
 *
 * The build command records an Op run named `check` on the land branch's
 * head, which passes unless the head holds `red.txt`. The serve judges
 * `ci.green.preMerge` from that record: a green land moves main and the land
 * branch goes; a red one leaves both. Each serve gets a fresh state
 * directory, so its first poll only notes main's head and runs no job.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, declaration, git, REPO, scratchDir, writeFiles } from "./__fixtures__/contract-repo";

afterAll(cleanScratch);

const LOADER = pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href;
const GREEN = { branch: "main", phases: { check: ["check"], suites: ["suites"] }, require: ["check", "suites"], preMerge: ["check"], source: "runs" };

/** Records an unsigned `check` run on the checkout's HEAD: it fails when `red.txt` is there. */
const RECORD_CHECK = `
import { existsSync } from "node:fs";
import { runOpLocally, OpRunFailure } from ${JSON.stringify(join(REPO, "packages/core/src/op/local-executor.ts"))};
const red = existsSync("red.txt");
const op = { name: "check", overview: "check", labels: { Env: "ci" }, phases: [{ name: "Run", steps: [{ kind: "activity", fn: "step", args: {} }] }] };
const fns = new Map([["step", async () => { if (red) throw new Error("red"); return {}; }]]);
try {
  await runOpLocally(op, fns, {}, undefined, { cwd: process.cwd(), ledger: { cwd: process.cwd() } });
} catch (err) {
  if (!(err instanceof OpRunFailure)) throw err;
}
`;

function chant(cwd: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" };
    // No forge and no key: nothing here may lean on either.
    for (const name of ["GITHUB_ACTIONS", "GITHUB_TOKEN", "GH_TOKEN", "CHANT_FORGE_TOKEN", "CHANT_RUNNER_KEY", "GITHUB_REPOSITORY"]) delete env[name];
    const child = spawn(process.execPath, ["--import", LOADER, join(REPO, "packages/core/src/cli/main.ts"), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => done({ code: code ?? 1, out, err }));
  });
}

function commit(root: string, file: string): string {
  writeFiles(root, { [file]: `${file}\n` });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", file);
  return git(root, "rev-parse", "HEAD");
}

function pushLand(root: string, name: string, files: string[]): string {
  git(root, "checkout", "-q", "-b", `land-${name}`, "main");
  let sha = "";
  for (const f of files) sha = commit(root, f);
  git(root, "push", "-q", "origin", `${sha}:refs/heads/chant/land/${name}`);
  git(root, "checkout", "-q", "main");
  return sha;
}

const remote = (origin: string, ref: string): string | null => {
  try {
    return git(origin, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return null;
  }
};

describe("ci serve --forge git --land, end to end (#4168 4.4, #4016 gap 6)", () => {
  let root: string;
  let origin: string;
  let main: string;
  let build: string;

  beforeAll(() => {
    origin = scratchDir("chant-land-e2e-origin-");
    git(origin, "init", "-q", "--bare");
    root = scratchDir("chant-land-e2e-work-");
    git(root, "init", "-q");
    git(root, "symbolic-ref", "HEAD", "refs/heads/main");
    git(root, "config", "user.name", "t");
    git(root, "config", "user.email", "t@example.com");
    git(root, "remote", "add", "origin", origin);
    writeFiles(root, {
      "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], { ci: { green: GREEN } }),
      "app/a.txt": "a\n",
    });
    main = commit(root, "init.txt");
    git(root, "push", "-q", "origin", "main");
    const script = join(scratchDir("chant-land-e2e-bin-"), "record-check.mts");
    writeFileSync(script, RECORD_CHECK);
    build = `${JSON.stringify(process.execPath)} --import ${JSON.stringify(LOADER)} ${JSON.stringify(script)}`;
  });

  const serve = (state: string) => chant(root, "ci", "serve", "--forge", "git", "--env", "prod", "--once", "--land", "--build-command", build, "--state", join(root, ".git", state));

  test("a land whose pre-merge phase passes moves main to it, and the land branch is deleted", async () => {
    const head = pushLand(root, "fix", ["fix-1.txt", "fix-2.txt"]);
    const r = await serve("serve-green");
    expect(r.err).toContain("no commit status is set");
    expect(r.err).toContain(`chant/land/fix at ${head.slice(0, 12)} landed, and the land branch was deleted`);
    expect(r.code).toBe(0);
    expect(remote(origin, "refs/heads/main")).toBe(head);
    expect(remote(origin, "refs/heads/chant/land/fix")).toBeNull();
    main = head;
  });

  test("a land whose pre-merge phase fails leaves main and the land branch", async () => {
    git(root, "fetch", "-q", "origin", "main");
    git(root, "reset", "-q", "--hard", "origin/main");
    const head = pushLand(root, "red", ["red.txt"]);
    const r = await serve("serve-red");
    expect(r.err).toContain(`chant/land/red at ${head.slice(0, 12)} was refused and left on the remote: the pre-merge phase check failed`);
    expect(remote(origin, "refs/heads/main")).toBe(main);
    expect(remote(origin, "refs/heads/chant/land/red")).toBe(head);
  });

  test("--land without a build command, or without ci.green.preMerge, is refused before the first poll", async () => {
    const noBuild = await chant(root, "ci", "serve", "--forge", "git", "--env", "prod", "--once", "--land");
    expect(noBuild.code).toBe(1);
    expect(noBuild.err).toContain("--land runs each land branch's pre-merge phases with --build-command");

    const bare = scratchDir("chant-land-e2e-nopre-");
    git(bare, "init", "-q");
    writeFiles(bare, { "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], { ci: { green: { ...GREEN, preMerge: undefined } } }) });
    const noPre = await chant(bare, "ci", "serve", "--forge", "git", "--env", "prod", "--once", "--land", "--build-command", "true");
    expect(noPre.code).toBe(1);
    expect(noPre.err).toContain("the declaration names none");
  });
});
