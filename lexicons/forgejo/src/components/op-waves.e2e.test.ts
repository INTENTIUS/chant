/**
 * #3690 end to end on a real Forgejo with a runner: a two-wave Op pipeline,
 * rendered by {@link generateForgejoOpWavesPipeline}, whose jobs run this
 * checkout's `chant run wave`.
 *
 * - Wave 1 (`dev`, gate `on-destructive`) plans a destructive run and waits
 *   at its gate (exit 3). Wave 2 (`prod`, gate `never`) needs it, so it never
 *   starts and applies nothing.
 * - `chant approve` of the digest wave 1 printed, then a dispatch of the
 *   workflow: wave 1 applies and wave 2 runs and applies.
 * - A broken copy of the workflow with wave 2's `needs` edge removed: wave 1
 *   still waits, wave 2 runs and applies, and the check the first run passed
 *   ({@link waitingWaveStoppedNext}) catches it.
 *
 * The plan and apply commands are shell scripts in the repository: plan
 * writes a fixed digest with `destructive: true`, apply prints a marker line.
 * This checkout's `@intentius/chant` is packed into the repository and each
 * job installs it, so the jobs run the code under test, not a release.
 *
 * Runs only with CHANT_E2E_FORGEJO_URL and CHANT_E2E_FORGEJO_TOKEN (a token
 * that creates and deletes repositories and pushes to them), against a
 * Forgejo whose runner takes `docker` jobs and reaches the npm registry.
 * chant's CI has no Forgejo, so its e2e job skips this file, as it skips the
 * other Forgejo e2e (`packages/core/src/op/gate-resume.e2e.test.ts`).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const URL_ = process.env.CHANT_E2E_FORGEJO_URL?.replace(/\/+$/, "");
const TOKEN = process.env.CHANT_E2E_FORGEJO_TOKEN;
const api = `${URL_}/api/v1`;

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../packages/core");
const CHANT = join(CORE, "bin/chant");

const SPEC: OpWavesSpec = {
  name: "demo",
  op: "demo",
  plan: ["sh", "plan.sh", "{target}", "{plan}"],
  apply: ["sh", "apply.sh", "{target}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], gate: "on-destructive" },
    { name: "prod", runs: [{ target: "prod" }], gate: "never" },
  ],
};

const PLAN_SH = `# Every run's plan is destructive, with a digest fixed by its target.
printf '{"planDigest":"sha256:%s","destructive":true}' "$(printf '%s' "$1" | sha256sum | cut -d' ' -f1)" > "$2"
`;
const APPLY_SH = `echo "CHANT_E2E_APPLIED $1"\n`;

async function call(method: string, path: string, body?: unknown): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any -- untyped forge JSON
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

interface Run {
  id: number;
  status: string;
}

/** One job of a finished run: its name, how it ended and its log. */
interface JobOutcome {
  name: string;
  status: string;
  log: string;
}

async function finishedRun(repo: string, after: number, timeoutMs = 600_000): Promise<Run> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const listed = await call("GET", `/repos/${repo}/actions/runs?limit=50`);
    const run = ((listed.workflow_runs ?? listed) as Run[]).find((r) => r.id > after);
    if (run && !["waiting", "running", "blocked", "unknown"].includes(run.status)) return run;
    await sleep(3000);
  }
  throw new Error(`no finished run in ${repo} within ${timeoutMs}ms`);
}

async function jobsOf(repo: string, run: number): Promise<Record<string, JobOutcome>> {
  const listed = await call("GET", `/repos/${repo}/actions/runs/${run}/jobs`);
  const out: Record<string, JobOutcome> = {};
  for (const job of (listed.jobs ?? listed) as Array<{ id: number; name: string; status: string; conclusion?: string }>) {
    const log = await call("GET", `/repos/${repo}/actions/jobs/${job.id}/logs`).catch(() => "");
    out[job.name] = { name: job.name, status: job.conclusion || job.status, log: String(log ?? "") };
  }
  return out;
}

const applied = (job: JobOutcome | undefined, target: string) => !!job && job.log.includes(`CHANT_E2E_APPLIED ${target}`);

/**
 * What the issue asks of a waiting wave: wave 1 waited at its gate, and wave
 * 2 neither succeeded nor applied anything. Returns why not, or null.
 */
function waitingWaveStoppedNext(jobs: Record<string, JobOutcome>): string | null {
  const first = jobs["wave-1-dev"];
  const second = jobs["wave-2-prod"];
  if (!first || first.status !== "failure" || !first.log.includes("Nothing in wave 1 or after it ran")) {
    return `wave 1 did not wait at its gate (${first?.status ?? "missing"})`;
  }
  if (applied(first, "dev")) return "wave 1 applied while waiting";
  if (second && (second.status === "success" || applied(second, "prod"))) return `wave 2 ran (${second.status}) while wave 1 waited`;
  return null;
}

describe.skipIf(!URL_ || !TOKEN)("a waiting Op wave stops the next on Forgejo (#3690)", () => {
  const stamp = Date.now().toString(36);
  const work = mkdtempSync(join(tmpdir(), "chant-e2e-waves-"));
  const created: string[] = [];
  let owner = "";
  let tarball = "";

  beforeAll(() => {
    // This checkout's chant, for the jobs to install. Its declaration build
    // is skipped: the bin runs the TypeScript sources through tsx.
    const out = execFileSync("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", work], { cwd: CORE, encoding: "utf-8" });
    tarball = join(work, out.trim().split("\n").pop()!);
  }, 300_000);

  afterAll(async () => {
    for (const repo of created) await call("DELETE", `/repos/${repo}`).catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  });

  /**
   * A repository whose `main` holds two commits: the spec, scripts and chant
   * first (the base the gate policy is read at), then the workflow. One push
   * of both runs the workflow once, at the second.
   */
  async function pushRepo(name: string, workflow: string): Promise<{ repo: string; dir: string }> {
    owner ||= (await call("GET", "/user")).login;
    await call("POST", "/user/repos", { name, auto_init: false, default_branch: "main", private: false });
    const repo = `${owner}/${name}`;
    created.push(repo);
    const dir = join(work, name);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "chant e2e");
    git(dir, "config", "user.email", "chant-e2e@example.invalid");
    writeFileSync(join(dir, "waves.json"), JSON.stringify(SPEC, null, 2) + "\n");
    writeFileSync(join(dir, "plan.sh"), PLAN_SH);
    writeFileSync(join(dir, "apply.sh"), APPLY_SH);
    writeFileSync(join(dir, ".gitignore"), ".chant/\n");
    execFileSync("cp", [tarball, join(dir, "chant.tgz")]);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "waves spec, plan and apply");
    mkdirSync(join(dir, ".forgejo/workflows"), { recursive: true });
    writeFileSync(join(dir, ".forgejo/workflows/demo.yml"), workflow);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "waves workflow");
    const remote = new URL(`${URL_}/${repo}.git`);
    remote.username = owner;
    remote.password = TOKEN!;
    git(dir, "remote", "add", "origin", remote.toString());
    git(dir, "push", "-q", "origin", "main");
    return { repo, dir };
  }

  const { files } = generateForgejoOpWavesPipeline(SPEC, { specFile: "waves.json", beforeScript: ["npm install --global --no-audit --no-fund ./chant.tgz"] });
  const workflow = files[0]!.yaml;
  const needsEdge = /\n\s+needs:\n\s+- wave-1-dev/;

  test("the rendered workflow chains wave 2 to wave 1", () => {
    expect(workflow).toMatch(needsEdge);
  });

  test("wave 1 waits and wave 2 never starts; after chant approve a rerun applies both; without the needs edge the check fails", async () => {
    const [good, broken] = await Promise.all([
      pushRepo(`chant-e2e-waves-${stamp}`, workflow),
      pushRepo(`chant-e2e-waves-broken-${stamp}`, workflow.replace(needsEdge, "")),
    ]);
    const [waited, brokenRun] = await Promise.all([finishedRun(good.repo, 0), finishedRun(broken.repo, 0)]);

    // Wave 1 waits at its gate; wave 2 never starts.
    const first = await jobsOf(good.repo, waited.id);
    expect(waitingWaveStoppedNext(first)).toBeNull();
    expect(first["wave-2-prod"]?.status).not.toBe("success");

    // Without the needs edge, wave 2 runs and applies while wave 1 waits, and the check says so.
    const unchained = await jobsOf(broken.repo, brokenRun.id);
    expect(unchained["wave-1-dev"]?.status).toBe("failure");
    expect(applied(unchained["wave-2-prod"], "prod")).toBe(true);
    expect(waitingWaveStoppedNext(unchained)).toMatch(/wave 2 ran/);

    // Approve the digest wave 1 printed, from a checkout of the repository.
    const approve = first["wave-1-dev"]!.log.match(/then approve: (chant approve \S+ \S+ --plan \S+)/)?.[1];
    expect(approve, "wave 1 printed the approve command").toBeDefined();
    const argv = approve!.split(" ").slice(1);
    execFileSync(CHANT, argv, { cwd: good.dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    expect(git(good.dir, "ls-remote", "origin", "refs/heads/chant/lifecycle")).toContain("chant/lifecycle");

    // A rerun applies wave 1, then wave 2 runs and applies.
    await call("POST", `/repos/${good.repo}/actions/workflows/demo.yml/dispatches`, { ref: "main" });
    const rerun = await finishedRun(good.repo, waited.id);
    const second = await jobsOf(good.repo, rerun.id);
    expect(second["wave-1-dev"]?.status).toBe("success");
    expect(applied(second["wave-1-dev"], "dev")).toBe(true);
    expect(second["wave-2-prod"]?.status).toBe("success");
    expect(applied(second["wave-2-prod"], "prod")).toBe(true);
  }, 1_500_000);
});
