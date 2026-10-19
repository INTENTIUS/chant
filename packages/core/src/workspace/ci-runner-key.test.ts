/**
 * #4099: the runner key on a `chant ci serve` or `chant ci run` host. The
 * key is made in the state directory with mode 0600, `--setup-key --trust`
 * proposes its runner entry on a branch through `trust runner add` (#3510)
 * and never writes the target branch, and `ci serve` refuses to start when
 * `.chant/trust.json` at the target's head does not list its key, unless
 * `--unsigned`.
 *
 * Every test works in its own temp repository with a bare origin and its own
 * state directory. The jobs' `chant` is a stub script, and no job runs: the
 * refusals come before the first poll.
 */

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanScratch, declaration, git, repoFixture, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { parseArgs } from "../cli/parse-args";
import type { CommandContext } from "../cli/registry";
import { ciServeRunnerKey, ensureHostRunnerKey, hostRunnerKey, RUNNER_KEY_FILE } from "./ci-runner-key";
import { runCiServe } from "./ci-serve";
import { runCiRun } from "./ci-run";
import { ciTagSigner } from "./ci-green";
import { trustWrite } from "./trust/trust-write";

const home = process.cwd();
afterEach(() => {
  process.chdir(home);
  vi.restoreAllMocks();
  cleanScratch();
});

/** The repository every test starts from, built once: a checkout on main with a bare origin, with commits made by a fixed identity and never signed. */
const workspaceTemplate = repoFixture(() => {
  const top = scratchDir("chant-runner-key-template-");
  const origin = join(top, "origin");
  const root = join(top, "root");
  mkdirSync(origin);
  mkdirSync(root);
  git(origin, "init", "-q", "--bare");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) git(root, "config", k!, v!);
  writeFiles(root, { "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }]), "app/a.txt": "a\n" });
  git(root, "remote", "add", "origin", origin);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  git(root, "push", "-q", "origin", "main");
  return top;
}, "chant-runner-key-");

/** A copy of the template, its origin pointed at the copy of the bare one. */
function workspace(): { root: string; origin: string; main: string } {
  const top = workspaceTemplate();
  const root = join(top, "root");
  const origin = join(top, "origin");
  git(root, "remote", "set-url", "origin", origin);
  return { root, origin, main: git(root, "rev-parse", "HEAD") };
}

/** Run a ci command line in `cwd`, with what it printed. */
async function cli(cwd: string, argv: string[], run: (ctx: CommandContext) => Promise<number> = runCiServe) {
  process.chdir(cwd);
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(String(s)));
  vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(String(s)));
  const code = await run({ args: parseArgs(argv) } as unknown as CommandContext);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A stand-in for `chant` the jobs would run; no test here reaches a job. */
function stubChant(): string {
  const file = join(scratchDir("chant-runner-key-bin-"), "chant");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

const SERVE = (state: string) => ["ci", "serve", "--forge", "forgejo", "--repo", "demo/estate", "--env", "local", "--once", "--state", state, "--chant", stubChant(), "--image", "node:22-bookworm"];

describe("the host's runner key (#4099)", () => {
  test("--setup-key makes an Ed25519 key with mode 0600, prints its public half, and reuses it", async () => {
    const { root } = workspace();
    const state = join(scratchDir("chant-runner-key-state-"), "ci-serve");
    const first = await cli(root, ["ci", "serve", "--setup-key", "--state", state]);
    expect(first.code).toBe(0);
    const path = join(state, RUNNER_KEY_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(state).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf-8")).toContain("BEGIN PRIVATE KEY");
    expect(first.out).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
    expect(first.err).toContain("made now, mode 0600");
    // It is not listed yet, so the exact command is printed.
    expect(first.err).toContain(`chant workspace trust runner add chant-runner:`);
    expect(first.err).toContain(`--key "${first.out}"`);

    // ci run --setup-key finds the same key and makes no other.
    const again = await cli(root, ["ci", "run", "--setup-key", "--state", state], runCiRun);
    expect(again.code).toBe(0);
    expect(again.out).toBe(first.out);
    expect(again.err).toContain("already here");

    // A key other users can read is refused.
    chmodSync(path, 0o644);
    expect(() => hostRunnerKey(state)).toThrow(/can be read by other users/);
    chmodSync(path, 0o600);
    expect(ensureHostRunnerKey(state).created).toBe(false);
  });

  test("--setup-key --trust pushes the runner entry on a branch of its own and leaves main as it was", async () => {
    const { root, origin, main } = workspace();
    const state = scratchDir("chant-runner-key-state-");
    const r = await cli(root, ["ci", "serve", "--setup-key", "--trust", "--principal", "chant-runner:demo", "--by", "github:alex", "--state", state]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("committed the runner entry for chant-runner:demo on chant/trust-runner/chant-runner-demo");
    const branch = "chant/trust-runner/chant-runner-demo";

    // main is untouched, here and on the remote; the branch holds the entry and the role.
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(main);
    expect(git(root, "rev-parse", "HEAD")).toBe(main);
    expect(git(root, "status", "--short")).toBe("");
    const trust = JSON.parse(git(origin, "show", `${branch}:.chant/trust.json`)) as { runners: { principal: string; key: string }[]; roles: { runner: string[] } };
    expect(trust.runners).toEqual([{ principal: "chant-runner:demo", class: "runner", key: r.out }]);
    expect(trust.roles.runner).toEqual(["chant-runner:demo"]);
    expect(git(origin, "rev-parse", `${branch}^`)).toBe(main);

    // Until it merges, ci serve refuses the key; once it has, the key signs as the principal.
    const key = hostRunnerKey(state)!;
    expect(() => ciServeRunnerKey({ top: root, stateDir: state, branch: "main" })).toThrow(/not trusted at main/);
    git(root, "push", "-q", "origin", `refs/remotes/origin/${branch}:refs/heads/main`);
    expect(ciServeRunnerKey({ top: root, stateDir: state, branch: "main" })).toMatchObject({ pem: key.pem, source: join(state, RUNNER_KEY_FILE) });
    expect(ciTagSigner(root, git(root, "rev-parse", "refs/remotes/origin/main"), key.pem).principal).toBe("chant-runner:demo");

    // Run again, it says the key is listed and proposes nothing.
    const listed = await cli(root, ["ci", "serve", "--setup-key", "--trust", "--state", state]);
    expect(listed.err).toContain("lists it for chant-runner:demo, with the runner role");
  });

  test("ci serve refuses to start with a key trust.json does not list at the target's head, and --unsigned starts without one", async () => {
    const { root } = workspace();
    const state = scratchDir("chant-runner-key-state-");

    const none = await cli(root, SERVE(state));
    expect(none.code).toBe(1);
    expect(none.err).toContain("there is no runner key");

    ensureHostRunnerKey(state);
    const unlisted = await cli(root, SERVE(state));
    expect(unlisted.code).toBe(1);
    expect(unlisted.err).toMatch(/not trusted at main [0-9a-f]{12}/);
    expect(unlisted.err).toContain("chant ci serve --setup-key --trust");
    expect(unlisted.err).toContain("chant workspace trust runner add");

    // A key listed only in the working tree, not at the head, is still refused.
    const other = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    writeFileSync(join(state, "other.pem"), other, { mode: 0o600 });
    expect(trustWrite({ cwd: root, action: "runner add", name: "ci-bot", key: join(state, "other.pem") })).toMatchObject({ changed: true });
    const flagged = await cli(root, [...SERVE(state), "--key", join(state, "other.pem")]);
    expect(flagged.code).toBe(1);
    expect(flagged.err).toContain("lists no runner with this key");

    expect(ciServeRunnerKey({ top: root, stateDir: state, branch: "main", unsigned: true })).toEqual({ fromFlag: false, source: "none (--unsigned)" });
  });
});
