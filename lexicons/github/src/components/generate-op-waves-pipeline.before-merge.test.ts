/**
 * #4984 on GitHub and Forgejo: the waves workflow's before-merge mode. A
 * dispatch on the default branch carries the decided head; each wave's
 * plan and apply jobs' guard reads the decision, the job checks the head
 * out after the default branch's checkout and before any of the change's
 * code, and the command reads its base from the default branch's commit.
 * #4987: each wave is a plan, a gate, an apply and a record job; the
 * runners, the trade and the environment stay with the jobs that run the
 * change's code. The done job merges after the last wave. The checkout
 * step runs against a real repository here.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { beforeMergeCheckoutScript } from "@intentius/chant/op/before-merge";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const cloud = { aws: { role: "arn:aws:iam::123456789012:role/apply", region: "us-east-1", audience: "sts.amazonaws.com" } };
const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  plan: ["terragucci", "plan", "{target}", "--out", "{plan}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], runner: ["self-hosted", "dev"], setup: [{ run: "npm ci" }] },
    { name: "prod", runs: [{ target: "prod" }], cloud, environment: { name: "prod" } },
  ],
} as OpWavesSpec;
const options = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", evidence: { identity: "oidc" as const } };

type Step = { name?: string; env?: Record<string, string>; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = { needs?: string[]; if?: string; "runs-on"?: unknown; env?: Record<string, string>; permissions?: Record<string, string>; environment?: unknown; steps: Step[] };
type Doc = { on: { workflow_dispatch?: { inputs?: Record<string, unknown> } }; jobs: Record<string, Job> };
const docOf = (o: Record<string, unknown>): Doc => parseYAML(generateGithubOpWavesPipeline(spec, { ...options, ...o }).files[0]!.yaml) as Doc;
const HEAD_STEP = "Check out the default branch and the pull request's decided head, with the token in this step alone";

describe("the before-merge mode on GitHub (#4984)", () => {
  const doc = docOf({ beforeMerge: { merge: "auto" } });

  test("the dispatch takes the decided head, and every wave and evidence job maps it", () => {
    expect(Object.keys(doc.on.workflow_dispatch!.inputs!)).toEqual(["pr", "head", "digest"]);
    for (const name of ["wave-1-dev-plan", "wave-1-dev-gate", "wave-1-dev", "wave-1-dev-record", "wave-2-prod", "wave-2-prod-plan-evidence"]) {
      expect(doc.jobs[name]!.env).toMatchObject({ CHANT_BEFORE_MERGE_PR: "${{ github.event.inputs.pr }}", CHANT_BEFORE_MERGE_HEAD: "${{ github.event.inputs.head }}", CHANT_BEFORE_MERGE_DIGEST: "${{ github.event.inputs.digest }}" });
    }
  });

  test("the guard reads the decision with the job's token, and the head is checked out before any of the change's code", () => {
    for (const name of ["wave-2-prod-plan", "wave-2-prod"]) {
      const wave = doc.jobs[name]!;
      const names = wave.steps.map((s) => s.name ?? s.uses?.replace(/@.*/, ""));
      expect(names.slice(0, 3)).toEqual(["Check the job runs where the spec set it to run", "Trade the job's OIDC token for its cloud identities", HEAD_STEP]);
      const guard = wave.steps[0]!;
      expect(JSON.parse(guard.env!.CHANT_JOB_GUARD!)).toMatchObject({ forge: "github", branches: ["main"], forgeEnvironment: "prod", beforeMerge: { op: "tf-apply" } });
      expect(guard.env!.GITHUB_TOKEN).toBe("${{ github.token }}");
      // After the trade, the token request is unset first.
      expect(wave.steps[2]!.run).toMatch(/^unset ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL .*\nset -eu\n/);
      expect(wave.steps[2]!.run).toContain('if [ -n "${CHANT_BEFORE_MERGE_HEAD:-}" ]; then\n');
    }
    const dev = doc.jobs["wave-1-dev-plan"]!;
    const head = dev.steps.findIndex((s) => s.name === HEAD_STEP);
    const setup = dev.steps.findIndex((s) => s.run?.trim().endsWith("\nnpm ci"));
    expect(head).toBeGreaterThan(0);
    expect(setup).toBeGreaterThan(head);
  });

  test("the command reads its base from the default branch's commit, and the runners, environments and trades stay with the jobs that run the change's code", () => {
    const command = doc.jobs["wave-1-dev-plan"]!.steps.find((s) => s.name === "Plan wave 1 (dev) and save the plan")!;
    expect(command.run).toContain('terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 1 --base "${CHANT_WAVES_BASE:-HEAD^1}" --phase plan');
    const push = parseYAML(generateGithubOpWavesPipeline(spec, options).files[0]!.yaml) as Doc;
    for (const name of ["wave-1-dev", "wave-2-prod"]) {
      for (const job of [`${name}-plan`, name]) {
        expect(doc.jobs[job]!["runs-on"]).toEqual(push.jobs[name]!["runs-on"]);
        expect(doc.jobs[job]!.environment).toEqual(push.jobs[name]!.environment);
      }
      // The gate and record jobs run on the spec's runner, in no environment.
      for (const job of [`${name}-gate`, `${name}-record`]) {
        expect(doc.jobs[job]!["runs-on"]).toBe("ubuntu-latest");
        expect(doc.jobs[job]!.environment).toBeUndefined();
      }
    }
    expect(doc.jobs["wave-2-prod-plan"]!.needs).toEqual(["wave-1-dev-record"]);
  });

  test("the evidence job signs the plan job's checks at the decided head, measured from the default branch's commit", () => {
    const evidence = doc.jobs["wave-2-prod-plan-evidence"]!;
    expect(evidence.needs).toEqual(["wave-2-prod-plan"]);
    const sign = evidence.steps.at(-1)!.run!;
    expect(sign).toContain("ci evidence sign --from-job wave-2-prod-plan --check-id plan:prod");
    expect(sign).toContain('--at "${CHANT_BEFORE_MERGE_HEAD:-$GITHUB_SHA}"');
    const checkout = evidence.steps[1]!.run!;
    expect(checkout).toContain('if [ -n "${CHANT_BEFORE_MERGE_HEAD:-}" ]; then CHANT_EVIDENCE_BASE="$(git rev-parse --verify HEAD^{commit})"');
    // The plan job holds no signing identity: its command leaves the signing to the evidence job.
    expect(doc.jobs["wave-2-prod-plan"]!.steps.find((s) => s.name === "Plan wave 2 (prod) and save the plan")!.env).toEqual({ CHANT_WAVE_EVIDENCE: "job" });
  });

  test("after the last wave, the done job merges at the decided head and releases the locks", () => {
    const done = doc.jobs["before-merge-done"]!;
    expect(done.needs).toEqual(["wave-2-prod-record"]);
    expect(done.if).toBe("${{ success() && github.event.inputs.head != '' }}");
    expect(done.permissions).toEqual({ contents: "write", "pull-requests": "write", statuses: "read", checks: "read" });
    expect(done.steps.at(-1)!.run).toBe("terragucci run wave --op tf-apply --wave 2 --merge auto --forge github");
  });

  test("without the mode the workflow is the push run's", () => {
    const push = parseYAML(generateGithubOpWavesPipeline(spec, options).files[0]!.yaml) as Doc;
    expect(push.on.workflow_dispatch).toEqual({});
    expect(push.jobs["before-merge-done"]).toBeUndefined();
    // #4987: one job per wave, as before; only wave 2 trades cloud credentials and signs in an evidence job.
    expect(Object.keys(push.jobs)).toEqual(["wave-1-dev", "wave-2-prod", "wave-2-prod-evidence"]);
    for (const job of Object.values(push.jobs)) {
      expect(Object.keys(job.env ?? {}).filter((k) => k.startsWith("CHANT_BEFORE_MERGE"))).toEqual([]);
      expect(job.steps.map((s) => s.name)).not.toContain(HEAD_STEP);
      expect(JSON.stringify(job.steps)).not.toContain("CHANT_WAVES_BASE");
    }
  });

  test("GitHub merges with the job's token unless a secret is named; a merge that is neither auto nor manual is refused", () => {
    const named = docOf({ beforeMerge: { merge: "auto", mergeTokenSecret: "MERGE_TOKEN", gate: "tf-apply" } }).jobs["before-merge-done"]!.steps.at(-1)!;
    expect(named.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}", CHANT_MERGE_TOKEN: "${{ secrets.MERGE_TOKEN }}" });
    expect(named.run).toBe("terragucci run wave --op tf-apply --wave 2 --merge auto --forge github --gate tf-apply --merge-token-env CHANT_MERGE_TOKEN");
    expect(docOf({ beforeMerge: {} }).jobs["before-merge-done"]!.steps.at(-1)!.run).toBe("terragucci run wave --op tf-apply --wave 2 --merge manual --forge github");
    expect(() => docOf({ beforeMerge: { merge: "sometimes" } })).toThrow("beforeMerge.merge is auto or manual");
  });
});

describe("a wave's prelude (#4984)", () => {
  test("runs in the command's own step, so what it exports reaches the command", () => {
    const jobs = docOf({ waveJobs: { dev: { prelude: ['export TG_PROVIDER_CACHE_DIR="$HOME/.tg"'] } } }).jobs;
    const command = jobs["wave-1-dev"]!.steps.find((s) => s.name === "Plan, gate and apply wave 1 (dev)")!;
    expect(command.run!.trim()).toBe('export TG_PROVIDER_CACHE_DIR="$HOME/.tg"\nterragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 1');
    expect(jobs["wave-2-prod"]!.steps.find((s) => s.name === "Plan, gate and apply wave 2 (prod)")!.run).not.toContain("TG_PROVIDER_CACHE_DIR");
  });
});

describe("the decided head's checkout step, against a real repository (#4984)", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const origin = mkdtempSync(join(tmpdir(), "chant-bm-origin-"));
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "a"), "1");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "base");
  const base = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "-b", "feature");
  writeFileSync(join(origin, "a"), "2");
  git(origin, "commit", "-q", "-am", "head");
  const head = git(origin, "rev-parse", "HEAD");
  git(origin, "update-ref", "refs/pull/7/head", head);
  git(origin, "checkout", "-q", "main");
  // The head is reachable from the pull request's ref alone, as a fork's is.
  git(origin, "branch", "-q", "-D", "feature");

  const run = (env: Record<string, string>, script = beforeMergeCheckoutScript("github", "terragucci")) => {
    const work = mkdtempSync(join(tmpdir(), "chant-bm-work-"));
    git(work, "clone", "-q", origin, ".");
    const envFile = join(work, "..", `${work.split("/").pop()}.env`);
    writeFileSync(envFile, "");
    const r = spawnSync("bash", ["-c", script], { cwd: work, encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GITHUB_ENV: envFile, ...env } });
    return { status: r.status, stderr: r.stderr, head: git(work, "rev-parse", "HEAD"), env: readFileSync(envFile, "utf-8"), has: (sha: string) => spawnSync("git", ["cat-file", "-e", sha], { cwd: work }).status === 0 };
  };

  test("a push run checks out nothing", () => {
    expect(run({})).toMatchObject({ status: 0, head: base, env: "" });
  });

  test("the decided head is checked out, and the default branch's commit kept as the base", () => {
    expect(run({ CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: head })).toMatchObject({ status: 0, head, env: `CHANT_WAVES_BASE=${base}\n` });
  });

  test("a pull request that moved after the decision stops the job, misplaced", () => {
    const r = run({ CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: base });
    expect(r.status).toBe(9);
    expect(r.stderr).toContain(`terragucci: pull request 7 moved to ${head.slice(0, 12)} after its head ${base.slice(0, 12)} was decided`);
    expect(r.head).toBe(base);
  });

  test("#4987: the gate and record jobs' fetch keeps the default branch checked out and the head's commit at hand", () => {
    const r = run({ CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: head }, beforeMergeCheckoutScript("github", "terragucci", { checkout: false }));
    expect(r).toMatchObject({ status: 0, head: base, env: `CHANT_WAVES_BASE=${base}\n` });
    expect(r.has(head)).toBe(true);
  });
});
