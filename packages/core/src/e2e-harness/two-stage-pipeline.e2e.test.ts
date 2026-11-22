/**
 * #5479: one small member through a two-stage pipeline on a local Forgejo
 * stack, the path a product's delivery bench walks. The stack is the e2e
 * harness's own (`./stack.ts`, `./forgejo.ts`): Forgejo and forgejo-runner
 * with the docker executor on one network, a registered runner, the author,
 * reviewer and admin, and a repository whose workflows `chant pipeline
 * generate forgejo` and `chant run --generate forgejo` wrote. The jobs run
 * this checkout's chant, packed and installed in the image the runner uses.
 *
 * What runs for real, on the forge's runner:
 *
 * 1. the first merge (a pull request) applies the first stage's waves and
 *    the cut hook cuts the member's first release at `release.first`
 *    (terragucci#1526, sql-yodeler#406)
 * 2. the cut's green gate, `release.green: forge-checks`, counts the run's
 *    own first wave through `--own-run-jobs` (terragucci#1531): the merge
 *    commit's only check is that run
 * 3. the generated promote workflow, started for `prod`, waits at the
 *    stage's gate and prints its approve line
 * 4. `chant approve --env prod --plan <digest>` (#5480) finds the fact the
 *    promote left, and the same promote runs through, with no second
 *    approval and nothing left waiting
 * 6. a drift check that finds drift hands its outputs on (Forgejo's runner
 *    drops a failed job's, terragucci#1528), the drift agent job is started,
 *    and the `-found` job carries the red
 *
 * Step 5 runs on the host: `chant run --components all --env prod` in a
 * checkout of the member waits at the same gate (#5475). It needs no runner.
 * It is a CLI call against the forge's `chant/lifecycle`, as a person's or a
 * product's would be.
 *
 * What is stubbed, and why:
 *
 * - The member has no cloud. Its first stage's waves apply with shell
 *   scripts (`plan.sh`, `apply.sh`), and its component's steps are `shell`.
 *   The step carries a `template` path, so the cut records a templates
 *   release the promote can deploy; the shell capability ignores the file.
 * - The drift check's finding is fixed. The Op runs a `shellCmd` whose
 *   stdout names `drifted: true`, in place of `chant lifecycle diff --live`
 *   against an estate. Everything after the Op, chant's `failOn: "drift"`
 *   exit, the published outputs, the agent and found jobs, is generated
 *   code.
 * - The drift agent job is scheduled and started, and stops where it needs a
 *   model: the stack has no model key, and the suite never gives it one. The
 *   suite asserts the job ran (it was not skipped), not that it opened a
 *   pull request.
 * - The dev deploy of the release (`chant run --components all --env dev
 *   --release`) runs on the host. A product's first stage applies its own
 *   way, and the promote reads the record that leaves.
 *
 * Runs only when Docker answers. Without it the suite is skipped, and says
 * so in its title. It runs on local Docker only: the stack is a project of
 * its own (`chant-e2e-5479`, its own network and a free host port), nothing
 * in it holds a cloud credential, and the host's chant runs with a clean
 * environment and an empty home. The suite stops its containers when it
 * ends.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { pendingApprovals } from "../lifecycle/pending-approvals";
import { ForgejoForge, forgejoApi, registerForgejoRunner, type Person } from "./forgejo";
import { guardedGit, remoteWith, run } from "./git";
import { harnessProjectDir } from "./index";
import { realClock } from "./ports";

const CORE = resolve(import.meta.dirname, "..", "..");
const REPO_ROOT = resolve(CORE, "..", "..");
const CHANT = join(CORE, "bin", "chant");

const PROJECT = "chant-e2e-5479";
const ORG = "e2e";
const NAME = "app";
const REPO = `${ORG}/${NAME}`;

const DOCKER = (() => {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
})();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── The member ──────────────────────────────────────────────────────────────

const CONFIG = `export default { environments: ["dev", "prod"], release: { tag: "v{version}", green: "forge-checks" } };\n`;

// Two waves in the first stage: the cut runs after the second, and the
// second's job needs the first's, so --own-run-jobs names the first.
const PIPELINE = `import { pipeline } from "@intentius/chant/pipeline";

export default pipeline({
  name: "app",
  defaults: { op: "app", plan: ["sh", "plan.sh", "{target}", "{plan}"], apply: ["sh", "apply.sh", "{target}"] },
  stages: [
    {
      name: "dev",
      waves: [
        { name: "check", runs: [{ target: "dev-check" }] },
        { name: "dev", runs: [{ target: "dev" }] },
      ],
      gate: { policy: "never" },
    },
    { name: "prod", waves: [{ name: "prod", runs: [{ target: "prod" }] }], gate: { policy: "always" } },
  ],
});
`;

const PLAN_SH = `printf '{"planDigest":"sha256:%s","destructive":false}' "$(printf '%s' "$1" | sha256sum | cut -d' ' -f1)" > "$2"\n`;
const APPLY_SH = `echo "CHANT_E2E_APPLIED $1"\n`;

const COMPONENT = `export const api = {
  name: "api",
  dependsOn: [],
  deploy: [{ phase: "Apply", steps: [{ kind: "shell", cmd: "echo CHANT_E2E_DEPLOYED api", template: "api.template.json" }] }],
};
`;

const DRIFT_OP = `import { Op } from "@intentius/chant/op";

export const op = Op({
  name: "drift-app",
  overview: "A drift check whose finding is fixed",
  failOn: "drift",
  phases: [
    {
      phase: "Diff",
      steps: [
        {
          kind: "activity",
          fn: "shellCmd",
          args: { cmd: "echo '{\\"drifted\\":true}'", json: true },
          outcomeAttribute: { name: "Drift", from: "json.drifted" },
        },
      ],
    },
  ],
});
`;

const OPS_SPEC = {
  ops: [{ name: "drift-app", trigger: { kind: "cron", schedule: "0 6 * * *" }, agent: { on: "drift", maxRuns: 1 } }],
  options: { beforeScript: ["ln -s /usr/local/lib/node_modules node_modules"] },
};

const MEMBER_FILES: Record<string, string> = {
  "chant.config.ts": CONFIG,
  ".chant/pipeline.ts": PIPELINE,
  "plan.sh": PLAN_SH,
  "apply.sh": APPLY_SH,
  "api.component.ts": COMPONENT,
  "api.template.json": `{"note":"the unit the component deploys"}\n`,
  "drift-app.op.ts": DRIFT_OP,
  "ops.json": JSON.stringify(OPS_SPEC, null, 2) + "\n",
  ".gitignore": "node_modules/\n.chant/op-waves/\n.chant/agent/\n",
};

// ── Forge reads ─────────────────────────────────────────────────────────────

interface ForgeRun {
  id: number;
  status: string;
  commit_sha?: string;
  workflow_id?: string;
}
interface ForgeJob {
  id: number;
  name: string;
  status: string;
}

const ENDED = new Set(["success", "failure", "cancelled", "skipped"]);

describe.skipIf(!DOCKER)(DOCKER ? "a two-stage pipeline end to end on a local Forgejo stack (#5479)" : "a two-stage pipeline end to end on a local Forgejo stack (#5479): skipped, Docker is not running", () => {
  const work = mkdtempSync(join(tmpdir(), "chant-e2e-5479-"));
  const home = join(work, "home");
  const composeFile = join(work, "compose.yaml");
  let url = "";
  let admin: Person;
  let author: Person;
  let reviewer: Person;
  let forge: ForgejoForge;
  let clone = "";
  let imageTag = "";
  let up = false;

  const git = guardedGit(undefined, "chant-e2e-5479");

  /** The host's chant: a clean environment, an empty home, no cloud variables, tsx on the path (an Op file is loaded through it). */
  function chant(cwd: string, args: string[], extra: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
    const env: NodeJS.ProcessEnv = {
      PATH: `${join(REPO_ROOT, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
      HOME: home,
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      USER: "e2e-approver",
      LANG: "C.UTF-8",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      ...extra,
    };
    const r = spawnSync(process.execPath, [CHANT, ...args], { cwd, env, encoding: "utf-8", timeout: 300_000 });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  const compose = (args: string[], timeoutMs = 600_000) =>
    run("docker", ["compose", "-p", PROJECT, "-f", composeFile, ...args], {
      cwd: work,
      env: { ...process.env, CHANT_E2E_PROJECT: PROJECT, CHANT_E2E_FORGEJO_PORT: url.split(":").pop()! },
      timeoutMs,
    });

  const api = <T>(who: Person, method: string, path: string, body?: unknown, missingOk = false) =>
    forgejoApi<T>(url, who.token, method, path, body, { missingOk });

  async function freePort(): Promise<number> {
    return new Promise((res, rej) => {
      const s = createServer();
      s.once("error", rej);
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => res(port));
      });
    });
  }

  async function runs(): Promise<ForgeRun[]> {
    const page = await api<{ workflow_runs?: ForgeRun[] }>(admin, "GET", `/repos/${REPO}/actions/runs?limit=50`);
    return page?.workflow_runs ?? [];
  }

  /** The first run of `workflow` that `pick` accepts and that has ended; runs of `before` are not new. */
  async function finishedRun(pick: (r: ForgeRun) => boolean, limitS = 900): Promise<ForgeRun> {
    const end = Date.now() + limitS * 1000;
    while (Date.now() < end) {
      const found = (await runs()).filter(pick).sort((a, b) => a.id - b.id)[0];
      if (found && ENDED.has(found.status)) return found;
      await sleep(3000);
    }
    throw new Error(`no run ended within ${limitS}s`);
  }

  async function jobsOf(run: number): Promise<Array<ForgeJob & { log: string }>> {
    const got = await api<ForgeJob[] | { jobs?: ForgeJob[] }>(admin, "GET", `/repos/${REPO}/actions/runs/${run}/jobs`);
    const list = Array.isArray(got) ? got : (got?.jobs ?? []);
    const out: Array<ForgeJob & { log: string }> = [];
    for (const j of list) {
      const res = await fetch(`${url}/api/v1/repos/${REPO}/actions/jobs/${j.id}/logs`, { headers: { authorization: `token ${admin.token}` } });
      out.push({ ...j, log: res.ok ? await res.text() : "" });
    }
    return out;
  }

  /** Start `workflow` on main by hand and wait for the run it started. */
  async function dispatch(workflow: string, inputs?: Record<string, string>): Promise<ForgeRun> {
    const before = new Set((await runs()).map((r) => r.id));
    await api(admin, "POST", `/repos/${REPO}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref: "main", ...(inputs ? { inputs } : {}) });
    return finishedRun((r) => !before.has(r.id) && r.workflow_id === workflow);
  }

  /** The member's own clone: current with the forge's branches, tags and `chant/lifecycle`. */
  async function sync(): Promise<void> {
    await git.git(clone, ["fetch", "-q", "--tags", "--force", "origin", "+refs/heads/*:refs/remotes/origin/*"], [admin.token]);
    await git.git(clone, ["fetch", "-q", "origin", "+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle"], [admin.token]).catch(() => "");
  }

  const dump = (label: string, jobs: Array<ForgeJob & { log: string }>) =>
    `${label}\n${jobs.map((j) => `--- ${j.name} (${j.status})\n${j.log.split("\n").slice(-60).join("\n")}`).join("\n")}`;

  const savedGit = { sys: process.env.GIT_CONFIG_NOSYSTEM, global: process.env.GIT_CONFIG_GLOBAL };

  beforeAll(async () => {
    mkdirSync(home, { recursive: true });
    // No credential helper (a keychain helper blocks a push to a local forge): git here reads no system or user config.
    writeFileSync(join(home, "gitconfig"), "");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");

    // This checkout's chant, built and packed, installed in the image the runner's jobs use.
    execFileSync("npm", ["run", "build"], { cwd: CORE, stdio: "ignore", timeout: 600_000 });
    const packed = execFileSync("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", work], { cwd: CORE, encoding: "utf-8" }).trim().split("\n").pop()!;
    const tarball = join(work, packed);
    imageTag = `${PROJECT}-job:${createHash("sha256").update(readFileSync(tarball)).digest("hex").slice(0, 12)}`;
    const have = spawnSync("docker", ["image", "inspect", imageTag], { stdio: "ignore" }).status === 0;
    if (!have) {
      const ctx = join(work, "image");
      mkdirSync(ctx);
      writeFileSync(join(ctx, "Dockerfile"), ["FROM node:22-bookworm", "RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends zip && rm -rf /var/lib/apt/lists/*", "COPY chant.tgz /tmp/chant.tgz", "RUN npm install -g --no-audit --no-fund /tmp/chant.tgz tsx", ""].join("\n"));
      execFileSync("cp", [tarball, join(ctx, "chant.tgz")]);
      await run("docker", ["build", "-q", "-t", imageTag, ctx], { timeoutMs: 900_000 });
    }

    // The stack: the harness's compose project, on a free port, as a project of its own.
    const port = await freePort();
    url = `http://localhost:${port}`;
    await run(process.execPath, [CHANT, "build", join(harnessProjectDir(), "src"), "--lexicon", "docker", "-o", composeFile], {
      cwd: harnessProjectDir(),
      env: { ...process.env, PATH: `${join(REPO_ROOT, "node_modules", ".bin")}:${process.env.PATH}`, CHANT_E2E_PROJECT: PROJECT },
      timeoutMs: 300_000,
    });
    up = true;
    await compose(["up", "-d", "forgejo", "forgejoRunner"]);
    for (let i = 0; i < 90; i++) {
      if (await fetch(`${url}/api/v1/version`).then((r) => r.ok, () => false)) break;
      await sleep(2000);
    }

    // The people, each with a token. Forgejo mints tokens over basic auth only.
    const password = createHash("sha256").update(`${PROJECT}-${Date.now()}`).digest("hex").slice(0, 24);
    const person = async (login: string, isAdmin: boolean): Promise<Person> => {
      await run("docker", ["exec", "-u", "git", `${PROJECT}-forgejo`, "forgejo", "admin", "user", "create", ...(isAdmin ? ["--admin"] : []), "--username", login, "--password", password, "--email", `${login}@chant-e2e.local`, "--must-change-password=false"]);
      const t = await forgejoApi<{ sha1?: string }>(url, "", "POST", `/users/${login}/tokens`, { name: PROJECT, scopes: ["all"] }, { basic: { login, password } });
      if (!t?.sha1) throw new Error(`no token for ${login}`);
      return { login, token: t.sha1 };
    };
    admin = await person("e2e-admin", true);
    author = await person("e2e-author", false);
    reviewer = await person("e2e-reviewer", false);

    await api(admin, "POST", "/orgs", { username: ORG, visibility: "public" });
    await api(admin, "POST", `/orgs/${ORG}/repos`, { name: NAME, default_branch: "main", auto_init: false, private: false });
    await api(admin, "PATCH", `/repos/${REPO}`, { has_actions: true });
    for (const who of [author, reviewer]) await api(admin, "PUT", `/repos/${REPO}/collaborators/${who.login}`, { permission: "write" });

    // The runner, on the project network, with the job image the workflows name. No environment of its own: no AWS variables, nothing real.
    await registerForgejoRunner({
      url,
      adminToken: admin.token,
      name: PROJECT,
      network: PROJECT,
      jobImage: imageTag,
      envs: {},
      async writeConfig(text) {
        await run("docker", ["exec", "-i", `${PROJECT}-forgejo-runner`, "sh", "-c", "cat > /data/config.yml"], { input: text });
      },
      async restart() {
        await run("docker", ["restart", `${PROJECT}-forgejo-runner`]);
      },
    });

    // The member: its files, the workflows chant renders from them, and the base commit with the CI skipped.
    const base = join(work, "base");
    mkdirSync(join(base, ".chant"), { recursive: true });
    for (const [path, text] of Object.entries(MEMBER_FILES)) {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      writeFileSync(join(base, path), text);
    }
    // An Op file imports @intentius/chant/op, so the member resolves it from this checkout, as a job resolves it from the image.
    mkdirSync(join(base, "node_modules", "@intentius"), { recursive: true });
    symlinkSync(CORE, join(base, "node_modules", "@intentius", "chant"));
    for (const args of [["pipeline", "generate", "forgejo"], ["run", "--generate", "forgejo", "--spec", "ops.json"]]) {
      const r = chant(base, args);
      if (r.code !== 0) throw new Error(`chant ${args.join(" ")} exited ${r.code}: ${r.stderr}`);
    }
    // The jobs run in the image with this checkout's chant.
    const wfDir = join(base, ".forgejo", "workflows");
    for (const f of execFileSync("ls", [wfDir], { encoding: "utf-8" }).trim().split("\n")) {
      const p = join(wfDir, f);
      writeFileSync(p, readFileSync(p, "utf-8").replaceAll("container: node:22", `container: ${imageTag}`));
    }
    await run("git", ["init", "-q", "-b", "main", base]);
    await git.git(base, ["add", "-A"]);
    await git.git(base, ["-c", "user.name=e2e-admin", "-c", "user.email=e2e-admin@chant-e2e.local", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "the member's base [skip ci]"]);
    const baseSha = await git.git(base, ["rev-parse", "HEAD"]);
    forge = new ForgejoForge({ url, repo: REPO, admin, author, reviewer, baseTree: base, clock: realClock, emailDomain: "chant-e2e.local" });
    await forge.forceMain(baseSha);

    clone = await git.clone(remoteWith(url, admin.login, admin.token, REPO), "member", [admin.token]);
    await git.git(clone, ["config", "user.name", "e2e-admin"]);
    await git.git(clone, ["config", "user.email", "e2e-admin@chant-e2e.local"]);
    mkdirSync(join(clone, "node_modules", "@intentius"), { recursive: true });
    symlinkSync(CORE, join(clone, "node_modules", "@intentius", "chant"));
  }, 1_500_000);

  afterAll(async () => {
    for (const [k, v] of [["GIT_CONFIG_NOSYSTEM", savedGit.sys], ["GIT_CONFIG_GLOBAL", savedGit.global]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (!up) return;
    // CHANT_E2E_5479_KEEP=1 leaves the stack up for a person to look at; the project is a throwaway one.
    if (process.env.CHANT_E2E_5479_KEEP === "1") {
      console.error(`kept ${PROJECT}: ${url}, admin token ${admin?.token}, clone ${clone}, work ${work}`);
      return;
    }
    // Job containers the runner has not removed, then the project.
    const left = spawnSync("docker", ["ps", "-q", "--filter", `network=${PROJECT}`], { encoding: "utf-8" }).stdout.split("\n").filter(Boolean);
    if (left.length > 0) spawnSync("docker", ["stop", "-t", "2", ...left], { stdio: "ignore" });
    await compose(["down", "-v", "--remove-orphans"]).catch(() => undefined);
  }, 300_000);

  // The state the steps hand on.
  let mergeSha = "";
  let release = "";
  let promoteDigest = "";

  test("1 and 2: the first merge applies the first stage and cuts the first release, counting the run's own jobs", async () => {
    const branch = "feat/first-change";
    await forge.pushBranch(branch, { "CHANGELOG.md": "# app\n\nthe first change\n" }, "feat: the first change");
    // Forgejo answers 404 for a branch it has not indexed yet, a moment after the push.
    let pull = 0;
    for (let i = 0; pull === 0; i++) {
      try {
        pull = await forge.openPull(branch, "the first change", "");
      } catch (err) {
        if (i >= 15) throw err;
        await sleep(2000);
      }
    }
    mergeSha = await forge.mergePull(pull);

    const ran = await finishedRun((r) => r.commit_sha === mergeSha && r.workflow_id === "app-dev.yml");
    const jobs = await jobsOf(ran.id);
    const byName = Object.fromEntries(jobs.map((j) => [j.name, j]));
    expect(ran.status, dump("the merge's run", jobs)).toBe("success");
    expect(byName["wave-1-check"]?.status).toBe("success");
    expect(byName["wave-2-dev"]?.status).toBe("success");
    expect(byName["wave-2-dev"]!.log).toContain("CHANT_E2E_APPLIED dev");

    // The cut named the first wave's job as its own run's, and the release is the first one.
    const cutLog = byName["wave-2-dev"]!.log;
    expect(cutLog, dump("the cut", jobs)).toMatch(/Cut .*0\.1\.0/);
    expect(cutLog).toContain("wave-1-check");

    await sync();
    const list = chant(clone, ["release", "list", "--json"]);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toContain("0.1.0");
    release = "0.1.0";
    // The cut's own line on the ledger records the jobs of its run that counted as green.
    const cuts = await git.git(clone, ["show", "chant/lifecycle:_releases/cuts.jsonl"]);
    const cut = cuts.split("\n").map((l) => JSON.parse(l) as { label?: string; green?: { ownRun?: string[] } }).find((c) => c.label === release);
    expect(cut?.green?.ownRun, cuts).toEqual(["wave-1-check"]);
  }, 1_200_000);

  test("the release is deployed to dev from its commit, as the promote's source", async () => {
    await sync();
    await git.git(clone, ["checkout", "-q", "--detach", mergeSha]);
    const r = chant(clone, ["run", "--components", "all", "--env", "dev", "--release", release]);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    await git.git(clone, ["push", "-q", "origin", "refs/heads/chant/lifecycle"], [admin.token]).catch(() => "");
    await git.git(clone, ["checkout", "-q", "--detach", "origin/main"]);
  }, 300_000);

  test("3: a promote into the second stage waits at its stage gate", async () => {
    const ran = await dispatch("app-promote.yml", { stage: "prod", release });
    const jobs = await jobsOf(ran.id);
    const log = jobs.map((j) => j.log).join("\n");
    expect(ran.status, dump("the promote", jobs)).toBe("failure");
    expect(log).toContain("[pipeline-gate-waiting]");
    const digest = /chant approve app prod --env prod --plan (\S+)/.exec(log)?.[1];
    expect(digest, dump("the promote", jobs)).toBeDefined();
    promoteDigest = digest!.replace(/\x1b\[[0-9;]*m/g, "");

    await sync();
    const waiting = await pendingApprovals({ cwd: clone, env: "prod" });
    expect(waiting.map((w) => [w.kind, w.op, w.gate, w.digest])).toEqual([["stage", "app", "prod", promoteDigest]]);
  }, 1_200_000);

  test("4: chant approve with the promote's digest lets it through, and no second approval is asked for", async () => {
    const approved = chant(clone, ["approve", "--env", "prod", "--plan", promoteDigest]);
    expect(approved.code, approved.stderr).toBe(0);
    await git.git(clone, ["push", "-q", "origin", "refs/heads/chant/lifecycle"], [admin.token]);

    const ran = await dispatch("app-promote.yml", { stage: "prod", release });
    const jobs = await jobsOf(ran.id);
    expect(ran.status, dump("the second promote", jobs)).toBe("success");
    const log = jobs.map((j) => j.log).join("\n");
    expect(log).not.toContain("pipeline-gate-waiting");
    expect(log).toMatch(/Promoted .*api.* dev -> prod/s);

    await sync();
    expect(await pendingApprovals({ cwd: clone, env: "prod" })).toEqual([]);
  }, 1_200_000);

  test("5: a direct chant run --components into the gated stage waits at the same gate", async () => {
    await sync();
    const r = chant(clone, ["run", "--components", "all", "--env", "prod"]);
    expect(r.code, r.stderr + r.stdout).toBe(3);
    const line = /chant approve app prod --env prod --plan (\S+)/.exec(r.stderr)?.[0];
    expect(line, r.stderr).toBeDefined();
    const waiting = await pendingApprovals({ cwd: clone, env: "prod" });
    expect(waiting.map((w) => [w.kind, w.op, w.gate])).toEqual([["stage", "app", "prod"]]);
    // The gate is the promote's, and a run is bound to the digest of its own plan, not the release's.
    expect(waiting[0]!.digest).not.toBe(promoteDigest);
  }, 300_000);

  test("6: a drift check that finds drift publishes its outputs, the agent job runs, and the found job is red", async () => {
    const ran = await dispatch("drift-app.yml");
    const jobs = await jobsOf(ran.id);
    const by = Object.fromEntries(jobs.map((j) => [j.name, j]));
    const shown = dump("the drift run", jobs);

    // The Op exited 2 under failOn: "drift"; the job still ended green, so its outputs went out.
    expect(by["drift-app"]?.status, shown).toBe("success");
    expect(by["drift-app"]!.log).toContain("exiting 2");
    // The agent job was started from the published output (not skipped). It stops at the model, which the stack does not have.
    expect(by["drift-app-agent"], shown).toBeDefined();
    expect(by["drift-app-agent"]!.status, shown).not.toBe("skipped");
    // The run shows the finding as red.
    expect(by["drift-app-found"]?.status, shown).toBe("failure");
    expect(ran.status, shown).toBe("failure");
  }, 1_200_000);

  test("the stack held no cloud credential", () => {
    expect(existsSync(join(home, ".aws"))).toBe(false);
  });
});
