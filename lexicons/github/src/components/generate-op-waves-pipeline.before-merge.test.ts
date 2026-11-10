/**
 * #4984 on GitHub and Forgejo: the waves workflow's before-merge mode. A
 * dispatch on the default branch carries the decided head; each wave job's
 * guard reads the decision, the job checks the head out after the default
 * branch's checkout and before any of the change's code, and the command
 * reads its base from the default branch's commit. The runners, the trade
 * and the evidence jobs are the push run's; the done job merges after the
 * last wave. The checkout step runs against a real repository here.
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
  step: { kind: "terraform-apply", root: "{target}" },
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

describe("the before-merge mode on GitHub (#4984)", () => {
  const doc = docOf({ beforeMerge: { merge: "auto" } });

  test("the dispatch takes the decided head, and every wave and evidence job maps it", () => {
    expect(Object.keys(doc.on.workflow_dispatch!.inputs!)).toEqual(["pr", "head", "digest"]);
    for (const name of ["wave-1-dev", "wave-2-prod", "wave-2-prod-evidence"]) {
      expect(doc.jobs[name]!.env).toMatchObject({ CHANT_BEFORE_MERGE_PR: "${{ github.event.inputs.pr }}", CHANT_BEFORE_MERGE_HEAD: "${{ github.event.inputs.head }}", CHANT_BEFORE_MERGE_DIGEST: "${{ github.event.inputs.digest }}" });
    }
  });

  test("the guard reads the decision with the job's token, and the head is checked out before any of the change's code", () => {
    const wave = doc.jobs["wave-2-prod"]!;
    const names = wave.steps.map((s) => s.name ?? s.uses?.replace(/@.*/, ""));
    expect(names.slice(0, 4)).toEqual(["Check the job runs where the spec set it to run", "Trade the job's OIDC token for its cloud identities", "actions/checkout", "Check out the pull request's decided head"]);
    const guard = wave.steps[0]!;
    expect(JSON.parse(guard.env!.CHANT_JOB_GUARD!)).toMatchObject({ forge: "github", branches: ["main"], forgeEnvironment: "prod", beforeMerge: { op: "tf-apply" } });
    expect(guard.env!.GITHUB_TOKEN).toBe("${{ github.token }}");
    // After the trade, the token request is unset first, as in every later step.
    expect(wave.steps[3]!.run).toMatch(/^unset ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL .*\nif \[ -n "\$\{CHANT_BEFORE_MERGE_HEAD:-\}" \]; then\n/);
    const dev = doc.jobs["wave-1-dev"]!;
    const head = dev.steps.findIndex((s) => s.name === "Check out the pull request's decided head");
    const setup = dev.steps.findIndex((s) => s.run === "npm ci");
    expect(head).toBeGreaterThan(0);
    expect(setup).toBeGreaterThan(head);
  });

  test("the command reads its base from the default branch's commit, and the runners, environments and trades are the push run's", () => {
    const command = doc.jobs["wave-1-dev"]!.steps.find((s) => s.name === "Plan, gate and apply wave 1 (dev)")!;
    expect(command.run).toContain('terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 1 --base "${CHANT_WAVES_BASE:-HEAD^1}"');
    const push = parseYAML(generateGithubOpWavesPipeline(spec, options).files[0]!.yaml) as Doc;
    for (const name of ["wave-1-dev", "wave-2-prod"]) {
      expect(doc.jobs[name]!["runs-on"]).toEqual(push.jobs[name]!["runs-on"]);
      expect(doc.jobs[name]!.environment).toEqual(push.jobs[name]!.environment);
      expect(doc.jobs[name]!.permissions).toEqual(push.jobs[name]!.permissions);
    }
    expect(Object.keys(doc.jobs).filter((j) => j !== "before-merge-done")).toEqual(Object.keys(push.jobs));
  });

  test("the evidence job signs at the decided head, measured from the default branch's commit", () => {
    const sign = doc.jobs["wave-2-prod-evidence"]!.steps.at(-1)!.run!;
    expect(sign).toContain('--at "${CHANT_BEFORE_MERGE_HEAD:-$GITHUB_SHA}"');
    const checkout = doc.jobs["wave-2-prod-evidence"]!.steps[1]!.run!;
    expect(checkout).toContain('if [ -n "${CHANT_BEFORE_MERGE_HEAD:-}" ]; then CHANT_EVIDENCE_BASE="$(git rev-parse --verify HEAD^{commit})"');
  });

  test("after the last wave, the done job merges at the decided head and releases the locks", () => {
    const done = doc.jobs["before-merge-done"]!;
    expect(done.needs).toEqual(["wave-2-prod"]);
    expect(done.if).toBe("${{ success() && github.event.inputs.head != '' }}");
    expect(done.permissions).toEqual({ contents: "write", "pull-requests": "write", statuses: "read", checks: "read" });
    expect(done.steps.at(-1)!.run).toBe("terragucci run wave --op tf-apply --wave 2 --merge auto --forge github");
  });

  test("without the mode the workflow is the push run's", () => {
    const push = parseYAML(generateGithubOpWavesPipeline(spec, options).files[0]!.yaml) as Doc;
    expect(push.on.workflow_dispatch).toEqual({});
    expect(push.jobs["before-merge-done"]).toBeUndefined();
    for (const job of Object.values(push.jobs)) {
      expect(Object.keys(job.env ?? {}).filter((k) => k.startsWith("CHANT_BEFORE_MERGE"))).toEqual([]);
      expect(job.steps.map((s) => s.name)).not.toContain("Check out the pull request's decided head");
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

  const run = (env: Record<string, string>) => {
    const work = mkdtempSync(join(tmpdir(), "chant-bm-work-"));
    git(work, "clone", "-q", origin, ".");
    const envFile = join(work, "..", `${work.split("/").pop()}.env`);
    writeFileSync(envFile, "");
    const r = spawnSync("bash", ["-c", beforeMergeCheckoutScript("github", "terragucci")], { cwd: work, encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GITHUB_ENV: envFile, ...env } });
    return { status: r.status, stderr: r.stderr, head: git(work, "rev-parse", "HEAD"), env: readFileSync(envFile, "utf-8") };
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
});
