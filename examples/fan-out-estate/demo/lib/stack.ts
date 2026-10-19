/**
 * The demo's stack and its one-time setup: `up` and `down`.
 *
 * up builds stack/ with chant (compose.yaml and Dockerfile.jobImage), builds
 * the job image, starts floci and Forgejo, makes the admin, the author and
 * the reviewer, registers the runner and starts it, makes the org, the repo
 * and the bucket, and pushes the base: the example as it sits in chant, with
 * its generated workflow, plus the reviewer's key in .chant/allowed_signers,
 * pushed with [skip ci]. Then it applies the base with `chant run`.
 *
 * Everything up learns (passwords, tokens, the runner's credentials, the base
 * commit) is kept in the state directory, outside the chant checkout.
 */
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** What up keeps. */
export interface DemoState {
  adminPassword: string;
  peoplePassword: string;
  admin?: Person;
  author?: Person;
  reviewer?: Person;
  runner?: { uuid: string; token: string };
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

/** docker compose on the built compose.yaml, as project chant-fan-out-demo. */
export function compose(c: StackConfig, args: string[], runner?: DemoState["runner"]): Promise<{ stdout: string }> {
  return run("docker", ["compose", "-p", PROJECT, "-f", join(STACK_DIR, "compose.yaml"), ...args], {
    cwd: STACK_DIR,
    env: {
      ...process.env,
      CHANT_FAN_OUT_DEMO_FORGEJO_PORT: String(c.forgejoPort),
      CHANT_FAN_OUT_DEMO_FLOCI_PORT: String(c.flociPort),
      CHANT_FAN_OUT_DEMO_RUNNER_UUID: runner?.uuid ?? "",
      CHANT_FAN_OUT_DEMO_RUNNER_TOKEN: runner?.token ?? "",
    },
    timeoutMs: 600_000,
    redact: runner ? [runner.token] : [],
  });
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

  const workflow = readFileSync(join(EXAMPLE_DIR, ".forgejo", "workflows", "chant-pr.yml"), "utf8");
  if (!workflow.includes(`container: ${JOB_IMAGE}`)) throw new Error(`the example's workflow does not run in ${JOB_IMAGE}, the image up builds`);

  log("starting floci and Forgejo");
  await compose(c, ["up", "-d", "floci", "forgejo"]);
  const url = forgeUrl(c);
  await waitFor(clock, "Forgejo", 120, async () => (await fetch(`${url}/api/v1/version`)).ok);
  await waitFor(clock, "floci", 60, async () => (await fetch(`${flociUrl(c)}/`)).status < 500);

  state.admin = await person(c, ADMIN, state.adminPassword, true);
  state.author = await person(c, AUTHOR, state.peoplePassword, false, state.admin.token);
  state.reviewer = await person(c, REVIEWER, state.peoplePassword, false, state.admin.token);
  writeState(c, state);
  const admin = state.admin.token;

  log("registering forgejo-runner");
  const runners = (await forgejoApi<Array<{ id: number; name: string }>>(url, admin, "GET", "/admin/actions/runners")) ?? [];
  for (const r of runners) if (r.name === PROJECT) await forgejoApi(url, admin, "DELETE", `/admin/actions/runners/${r.id}`, undefined, { missingOk: true });
  const reg = await forgejoApi<{ uuid?: string; token?: string }>(url, admin, "POST", "/admin/actions/runners", { name: PROJECT, description: "the chant fan-out demo's docker executor" });
  if (!reg?.uuid || !reg.token) throw new Error("Forgejo returned no runner uuid and token");
  state.runner = { uuid: reg.uuid, token: reg.token };
  writeState(c, state);
  await compose(c, ["up", "-d", "--force-recreate", "runner"], state.runner);

  log(`making ${REPO}`);
  if (!(await forgejoApi(url, admin, "GET", `/orgs/${ORG}`, undefined, { missingOk: true }))) {
    await forgejoApi(url, admin, "POST", "/orgs", { username: ORG, visibility: "public" });
  }
  if (!(await forgejoApi(url, admin, "GET", `/repos/${REPO}`, undefined, { missingOk: true }))) {
    await forgejoApi(url, admin, "POST", `/orgs/${ORG}/repos`, { name: REPO_NAME, default_branch: "main", auto_init: false, private: false });
  }
  await forgejoApi(url, admin, "PATCH", `/repos/${REPO}`, { has_actions: true });
  for (const login of [AUTHOR, REVIEWER]) await forgejoApi(url, admin, "PUT", `/repos/${REPO}/collaborators/${login}`, { permission: "write" });

  const { FlociBucket } = await import("./bucket.js");
  await new FlociBucket(flociUrl(c), BUCKET).create();

  log("pushing the base");
  state.baseSha = await pushBase(c, state.admin);
  writeState(c, state);
  return state;
}

/** The reviewer's ssh key, made once. */
async function reviewerKey(c: StackConfig): Promise<string> {
  const key = reviewerKeyOf(c);
  if (!existsSync(key)) await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", REVIEWER, "-f", key]);
  return readFileSync(`${key}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
}

/** The paths of the example the base leaves out: the demo itself, build output, and the test that needs the checkout. */
const BASE_EXCLUDE = new Set(["demo", "node_modules", "dist", ".chant", "chant-pr-workflow.test.ts"]);

/** The base tree, committed and force-pushed to main. Returns its sha. */
export async function pushBase(c: StackConfig, admin: Person): Promise<string> {
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
  await git(tree, ["add", "-A"]);
  await git(tree, [
    "-c", `user.name=${admin.login}`, "-c", `user.email=${admin.login}@chant-demo.local`, "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", "The demo's base: fifteen CloudFormation stacks [skip ci]",
  ]);
  await git(tree, ["push", "-q", "--force", remoteWith(forgeUrl(c), admin.login, admin.token, REPO), "HEAD:refs/heads/main"], [admin.token]);
  return git(tree, ["rev-parse", "HEAD"]);
}

/** Stop the stack and remove its volumes. The state directory is kept unless `purge`. */
export async function down(c: StackConfig, purge = false): Promise<void> {
  await compose(c, ["down", "-v", "--remove-orphans"]);
  if (purge) rmSync(c.stateDir, { recursive: true, force: true });
}

