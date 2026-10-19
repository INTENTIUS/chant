/**
 * The demo's stack and its one-time setup: `up` and `down`.
 *
 * up builds stack/ with chant (compose.yaml and Dockerfile.jobImage), builds
 * the job image, writes the runner's secrets file, starts floci and Forgejo,
 * makes the admin, the author, the reviewer and the chant-runner user, makes
 * the org, the repo (Forgejo Actions off) and the bucket, and sets up the
 * runner key with `chant ci serve --setup-key` in the runner's container.
 * Then it pushes the base: the example as it sits in chant, without its
 * workflow, plus the reviewer's key in .chant/allowed_signers and the
 * runner's key in .chant/trust.json, pushed with [skip ci]. Last it starts
 * chant-runner, which serves the repo with `chant ci serve`. The driver then
 * applies the base with `chant run`.
 *
 * Everything up learns (passwords, tokens, the runner's public key, the base
 * commit) is kept in the state directory, outside the chant checkout.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { AUTHOR, BUCKET, FORGE_HOST, ORG, REPO, REPO_NAME, REVIEWER } from "../steps.js";
import { CHANT_BIN } from "./chant.js";
import { forgejoApi, type Person } from "./forgejo.js";
import { git, insideCheckout, remoteWith, run } from "./git.js";
import type { Clock, Log } from "./ports.js";

export const PROJECT = "chant-fan-out-demo";
export const JOB_IMAGE = "chant-fan-out-demo-job:local";
export const DEMO_DIR = resolve(import.meta.dirname, "..");
export const EXAMPLE_DIR = resolve(DEMO_DIR, "..");
export const STACK_DIR = join(DEMO_DIR, "stack");

export interface StackConfig {
  forgejoPort: number;
  flociPort: number;
  stateDir: string;
}

export function stackConfig(env: NodeJS.ProcessEnv = process.env): StackConfig {
  const stateDir = resolve(env.CHANT_FAN_OUT_DEMO_STATE ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), PROJECT));
  return {
    forgejoPort: Number(env.CHANT_FAN_OUT_DEMO_FORGEJO_PORT ?? 3390),
    flociPort: Number(env.CHANT_FAN_OUT_DEMO_FLOCI_PORT ?? 4590),
    stateDir,
  };
}

export const forgeUrl = (c: StackConfig): string => `http://localhost:${c.forgejoPort}`;
export const flociUrl = (c: StackConfig): string => `http://localhost:${c.flociPort}`;
export const baseTreeOf = (c: StackConfig): string => join(c.stateDir, "base-tree");
export const reviewerKeyOf = (c: StackConfig): string => join(c.stateDir, "reviewer.key");
export const runnerSecretsOf = (c: StackConfig): string => join(c.stateDir, "runner-secrets.env");

/** The compose service of chant's runner, and the names it uses (stack/src/compose.ts). */
export const RUNNER_SERVICE = "chantRunner";
export const RUNNER_LOGIN = "chant-runner";
export const RUNNER_STATE = "/var/lib/chant-runner";
/** Who .chant/trust.json lists the runner's key for, with the runner role. */
export const RUNNER_PRINCIPAL = "chant-runner:fan-out-demo";

/** What every job gets from the runner's secrets file: floci's endpoint and test credentials. */
export const RUNNER_SECRETS_TEXT = [
  "# The chant fan-out demo's runner secrets, written by up: floci's endpoint and test credentials.",
  "AWS_ENDPOINT_URL=http://floci:4566",
  "AWS_ACCESS_KEY_ID=test",
  "AWS_SECRET_ACCESS_KEY=test",
  "AWS_REGION=us-east-1",
  "",
].join("\n");

/** What up keeps. */
export interface DemoState {
  adminPassword: string;
  peoplePassword: string;
  admin?: Person;
  author?: Person;
  reviewer?: Person;
  /** The Forgejo user chant's runner works as. */
  runner?: Person;
  /** The runner's public key, `ssh-ed25519 <base64>`, as .chant/trust.json lists it. */
  runnerKey?: string;
  baseSha?: string;
}

const STATE_FILE = "state.json";
const ADMIN = "chant-admin";

export function readState(c: StackConfig): DemoState | null {
  const path = join(c.stateDir, STATE_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as DemoState) : null;
}

function writeState(c: StackConfig, s: DemoState): void {
  mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(c.stateDir, STATE_FILE), `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
}

/** The state up wrote, with everything a cycle needs. */
export function readyState(c: StackConfig): Required<Pick<DemoState, "admin" | "author" | "reviewer" | "baseSha">> & DemoState {
  const s = readState(c);
  if (!s?.admin || !s.author || !s.reviewer || !s.baseSha) throw new Error(`no demo state in ${c.stateDir}; run "npm run demo -- up" first`);
  return s as Required<Pick<DemoState, "admin" | "author" | "reviewer" | "baseSha">> & DemoState;
}

/**
 * docker compose on the built compose.yaml, as project chant-fan-out-demo.
 * The runner's token and secrets file go in the environment, where the
 * compose file reads them.
 */
export function compose(c: StackConfig, args: string[], runnerToken?: string): Promise<{ stdout: string }> {
  return run("docker", ["compose", "-p", PROJECT, "-f", join(STACK_DIR, "compose.yaml"), ...args], {
    cwd: STACK_DIR,
    env: {
      ...process.env,
      CHANT_FAN_OUT_DEMO_FORGEJO_PORT: String(c.forgejoPort),
      CHANT_FAN_OUT_DEMO_FLOCI_PORT: String(c.flociPort),
      CHANT_FAN_OUT_DEMO_RUNNER_TOKEN: runnerToken ?? "",
      CHANT_FAN_OUT_DEMO_RUNNER_SECRETS: runnerSecretsOf(c),
    },
    timeoutMs: 600_000,
    redact: runnerToken ? [runnerToken] : [],
  });
}

/** The environment the checkout's chant runs in for up: none of chant's own variables, so it reads the base tree alone. */
function chantEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("CHANT_")) delete env[key];
  return env;
}

/** The checkout's chant in `cwd`. */
export const checkoutChant = (args: string[], cwd: string): Promise<{ stdout: string }> => run(CHANT_BIN, args, { cwd, env: chantEnv(), timeoutMs: 120_000 });

/** Write the runner's secrets file, mode 0600, which compose mounts into chant-runner. */
export function writeRunnerSecrets(c: StackConfig): string {
  mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  const path = runnerSecretsOf(c);
  writeFileSync(path, RUNNER_SECRETS_TEXT, { mode: 0o600 });
  // writeFileSync keeps the mode of a file that was there already.
  chmodSync(path, 0o600);
  return path;
}

/**
 * In the runner's container, with its state volume: clear the serve's state
 * from an earlier up (its clone, job state and resume records, so the first
 * pass takes the new base as its baseline), keep the key, and run `chant ci
 * serve --setup-key`, which makes the key when there is none and prints its
 * public half. setup-key keeps the key in git's directory unless told
 * otherwise, so it runs in an empty repository with `--state`.
 */
export const RUNNER_KEY_SCRIPT = [
  "set -e",
  `cd ${RUNNER_STATE}`,
  "rm -rf repo resume reports",
  "find . -maxdepth 1 -name '*.json' -delete",
  "rm -rf /tmp/chant-runner-key",
  "git init -q /tmp/chant-runner-key",
  "cd /tmp/chant-runner-key",
  `chant ci serve --setup-key --state ${RUNNER_STATE} --branch main`,
].join("; ");

/** The runner key's public half, made in the runner's state volume when there is none. */
export async function setupRunnerKey(composeRun: (args: string[]) => Promise<{ stdout: string }>): Promise<string> {
  const out = await composeRun(["run", "--rm", "--no-deps", "-T", RUNNER_SERVICE, "sh", "-c", RUNNER_KEY_SCRIPT]);
  const key = out.stdout
    .split("\n")
    .map((l) => l.trim())
    .reverse()
    .find((l) => /^ssh-ed25519 [A-Za-z0-9+/]+=*$/.test(l));
  if (!key) throw new Error("chant ci serve --setup-key printed no ssh-ed25519 key");
  return key;
}

/** List the runner's key in the tree's .chant/trust.json, with the runner role, through chant. */
export async function trustRunner(tree: string, publicKey: string, chant: typeof checkoutChant = checkoutChant): Promise<void> {
  const out = await chant(["workspace", "trust", "runner", "add", RUNNER_PRINCIPAL, "--key", publicKey], tree);
  const doc = JSON.parse(out.stdout) as { error?: { code: string; message: string }; changed?: boolean };
  if (doc.error) throw new Error(`chant workspace trust runner add refused (${doc.error.code}): ${doc.error.message}`);
}

const secret = (): string => randomBytes(18).toString("base64url");

async function waitFor(clock: Clock, what: string, seconds: number, ok: () => Promise<boolean>): Promise<void> {
  const deadline = clock.now() + seconds * 1000;
  while (!(await ok().catch(() => false))) {
    if (clock.now() >= deadline) throw new Error(`${what} was not ready within ${seconds}s`);
    await clock.sleep(2000);
  }
}

/** A Forgejo user, made with Forgejo's own CLI when missing, and a fresh token for it. */
async function person(c: StackConfig, login: string, password: string, admin: boolean, adminToken?: string): Promise<Person> {
  const url = forgeUrl(c);
  const exists = adminToken
    ? (await forgejoApi(url, adminToken, "GET", `/users/${login}`, undefined, { missingOk: true })) !== null
    : (await forgejoApi(url, "", "GET", "/user", undefined, { missingOk: true, basic: { login, password } }).catch(() => null)) !== null;
  if (!exists) {
    await compose(c, [
      "exec", "-T", "-u", "git", "forgejo", "forgejo", "admin", "user", "create",
      ...(admin ? ["--admin"] : []),
      "--username", login, "--password", password, "--email", `${login}@chant-demo.local`, "--must-change-password=false",
    ]);
  }
  const basic = { login, password };
  await forgejoApi(url, "", "DELETE", `/users/${login}/tokens/${PROJECT}`, undefined, { missingOk: true, basic }).catch(() => null);
  const t = await forgejoApi<{ sha1?: string }>(url, "", "POST", `/users/${login}/tokens`, { name: PROJECT, scopes: ["all"] }, { basic });
  if (!t?.sha1) throw new Error(`could not mint a token for ${login}`);
  return { login, token: t.sha1 };
}

/** Bring the stack up and push and apply the base. */
export async function up(c: StackConfig, clock: Clock, log: Log): Promise<DemoState> {
  mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  if (insideCheckout(c.stateDir)) {
    throw new Error(`the state directory ${c.stateDir} is inside the chant checkout; set CHANT_FAN_OUT_DEMO_STATE outside it`);
  }
  const state: DemoState = readState(c) ?? { adminPassword: secret(), peoplePassword: secret() };
  writeState(c, state);

  log("building the stack's compose.yaml and the job image's Dockerfile with chant");
  await run(CHANT_BIN, ["build", "src", "--lexicon", "docker", "-o", "compose.yaml"], { cwd: STACK_DIR });
  log(`building ${JOB_IMAGE}`);
  await run("docker", ["build", "-q", "-t", JOB_IMAGE, "-f", join(STACK_DIR, "Dockerfile.jobImage"), STACK_DIR], { timeoutMs: 1_200_000 });
  writeRunnerSecrets(c);

  log("starting floci and Forgejo");
  await compose(c, ["up", "-d", "floci", "forgejo"]);
  const url = forgeUrl(c);
  await waitFor(clock, "Forgejo", 120, async () => (await fetch(`${url}/api/v1/version`)).ok);
  await waitFor(clock, "floci", 60, async () => (await fetch(`${flociUrl(c)}/`)).status < 500);

  state.admin = await person(c, ADMIN, state.adminPassword, true);
  state.author = await person(c, AUTHOR, state.peoplePassword, false, state.admin.token);
  state.reviewer = await person(c, REVIEWER, state.peoplePassword, false, state.admin.token);
  state.runner = await person(c, RUNNER_LOGIN, state.peoplePassword, false, state.admin.token);
  writeState(c, state);
  const admin = state.admin.token;

  log(`making ${REPO}`);
  if (!(await forgejoApi(url, admin, "GET", `/orgs/${ORG}`, undefined, { missingOk: true }))) {
    await forgejoApi(url, admin, "POST", "/orgs", { username: ORG, visibility: "public" });
  }
  if (!(await forgejoApi(url, admin, "GET", `/repos/${REPO}`, undefined, { missingOk: true }))) {
    await forgejoApi(url, admin, "POST", `/orgs/${ORG}/repos`, { name: REPO_NAME, default_branch: "main", auto_init: false, private: false });
  }
  // chant's runner runs the jobs; Forgejo Actions runs nothing here.
  await forgejoApi(url, admin, "PATCH", `/repos/${REPO}`, { has_actions: false });
  for (const login of [AUTHOR, REVIEWER, RUNNER_LOGIN]) await forgejoApi(url, admin, "PUT", `/repos/${REPO}/collaborators/${login}`, { permission: "write" });

  const { FlociBucket } = await import("./bucket.js");
  await new FlociBucket(flociUrl(c), BUCKET).create();

  log("setting up the runner key");
  state.runnerKey = await setupRunnerKey((args) => compose(c, args, state.runner!.token));
  writeState(c, state);

  log("pushing the base");
  state.baseSha = await pushBase(c, state.admin, state.runnerKey);
  writeState(c, state);

  log("starting chant-runner");
  await compose(c, ["up", "-d", "--force-recreate", RUNNER_SERVICE], state.runner.token);
  return state;
}

/** The reviewer's ssh key, made once. */
async function reviewerKey(c: StackConfig): Promise<string> {
  const key = reviewerKeyOf(c);
  if (!existsSync(key)) await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", REVIEWER, "-f", key]);
  return readFileSync(`${key}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
}

/**
 * The paths of the example the base leaves out: the demo itself, build
 * output, the workflow (chant's runner runs the jobs, so the demo repo has no
 * workflow file) and the test that regenerates it, which needs the checkout.
 */
export const BASE_EXCLUDE = new Set(["demo", "node_modules", "dist", ".chant", ".forgejo", "chant-pr-workflow.test.ts"]);

/** How pushBase reaches chant and the forge. The tests pass a fake chant and a local remote. */
export interface PushBaseOptions {
  chant?: typeof checkoutChant;
  /** Where main is pushed. Default the demo repo on the demo's Forgejo, as the admin. */
  remote?: string;
}

/**
 * The base tree, committed and force-pushed to main. Returns its sha. The
 * runner's key is listed in its .chant/trust.json, so `ci serve` signs runs
 * the base trusts. The demo owns its repo, so the entry goes in with the
 * base, not through `--setup-key --trust`'s branch for review.
 */
export async function pushBase(c: StackConfig, admin: Person, runnerKey: string, opts: PushBaseOptions = {}): Promise<string> {
  const tree = baseTreeOf(c);
  rmSync(tree, { recursive: true, force: true });
  cpSync(EXAMPLE_DIR, tree, {
    recursive: true,
    filter: (src) => {
      const rel = relative(EXAMPLE_DIR, src);
      return rel === "" || !BASE_EXCLUDE.has(rel.split("/")[0]!);
    },
  });
  const pub = await reviewerKey(c);
  mkdirSync(join(tree, ".chant"), { recursive: true });
  // chant's pull-request gate names the reviewer as the forge does.
  writeFileSync(join(tree, ".chant", "allowed_signers"), `forgejo@${FORGE_HOST}:${REVIEWER} ${pub}\n${REVIEWER} ${pub}\n`);
  writeFileSync(join(tree, ".gitignore"), "node_modules/\ndist/\n.chant/pr/\n.chant/pr-resume/\n");
  await run("git", ["init", "-q", "-b", "main", tree]);
  await trustRunner(tree, runnerKey, opts.chant);
  await git(tree, ["add", "-A"]);
  await git(tree, [
    "-c", `user.name=${admin.login}`, "-c", `user.email=${admin.login}@chant-demo.local`, "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", "The demo's base: fifteen CloudFormation stacks [skip ci]",
  ]);
  await git(tree, ["push", "-q", "--force", opts.remote ?? remoteWith(forgeUrl(c), admin.login, admin.token, REPO), "HEAD:refs/heads/main"], [admin.token]);
  return git(tree, ["rev-parse", "HEAD"]);
}

/** Stop the stack (Forgejo, chant-runner and floci) and remove its volumes, the runner's state and key with them. The state directory is kept unless `purge`. */
export async function down(c: StackConfig, purge = false): Promise<void> {
  await compose(c, ["down", "-v", "--remove-orphans"]);
  if (purge) rmSync(c.stateDir, { recursive: true, force: true });
}

