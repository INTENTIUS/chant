/**
 * The `chant` workflow must run the lexicon prepacks under the same release
 * gate the publish arms (#1481).
 *
 * A release train publishes the newest green commit, on the premise that
 * green means publishable. That premise holds only if the checks publish
 * performs are a subset of the checks CI performs. They were not:
 * CHANT_RELEASE_GATE=1 was set solely on the publish step, so the
 * surface-snapshot check and the pinned-spec refusal ran in exactly the one
 * place a green build had never exercised. This pins the workflows to each
 * other so the gap cannot reopen without a failing test.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = {
  env?: Record<string, string>;
  steps?: Step[];
  needs?: string[];
  if?: string;
  permissions?: Record<string, string>;
};
type Workflow = { on: Record<string, unknown>; concurrency?: Record<string, unknown>; jobs: Record<string, Job> };

const root = join(import.meta.dirname, "..");
const workflow = (file: string): Workflow =>
  load(readFileSync(join(root, ".github", "workflows", file), "utf8")) as Workflow;

/** The value of `name` a step or its job exposes to `run`, job env first, step env winning. */
function envOf(job: Job, step: Step, name: string): string | undefined {
  return step.env?.[name] ?? job.env?.[name];
}

function stepsRunning(job: Job, pattern: RegExp): Step[] {
  return (job.steps ?? []).filter((s) => s.run && pattern.test(s.run));
}

describe("release gate parity (#1481)", () => {
  const train = workflow("publish.yml");
  const chant = workflow("chant.yml");
  const gate = "1";

  // #5154: a release train publishes from the generated publish.yml, on a
  // dispatch or its release-train/npm/<id> tag, so every package keeps its
  // trusted-publisher record. The train's gate is the newest green commit
  // (ci last-green), which the cut checks again, and the packages build under
  // the release gate.
  it("a release-train tag runs publish.yml, whose train publish runs under the release gate", () => {
    const trainTags = (train.on as { push: { tags: string[] } }).push.tags;
    expect(trainTags).toEqual(["release-train/npm/*"]);
    expect(stepsRunning(train.jobs.gate, /ci last-green/)).toHaveLength(1);
    expect(stepsRunning(train.jobs.cut, /workspace train cut npm --at "\$CHANT_RELEASE_COMMIT"/)).toHaveLength(1);
    const job = train.jobs.publish;
    const steps = job.steps ?? [];
    const fetchAt = steps.findIndex((s) => /chant\/lifecycle:chant\/lifecycle/.test(s.run ?? ""));
    const prepare = stepsRunning(job, /workspace train prepare npm/);
    const pub = stepsRunning(job, /workspace train publish npm/);
    expect(prepare).toHaveLength(1);
    expect(pub).toHaveLength(1);
    expect(fetchAt).toBeGreaterThanOrEqual(0);
    expect(fetchAt).toBeLessThan(steps.indexOf(prepare[0]));
    expect(steps.indexOf(prepare[0])).toBeLessThan(steps.indexOf(pub[0]));
    expect(envOf(job, pub[0], "CHANT_RELEASE_GATE")).toBe(gate);
    expect(envOf(job, pub[0], "NPM_TOKEN")).toBe("${{ secrets.NPM_TOKEN }}");
    expect(job.permissions?.["id-token"]).toBe("write");
  });

  // #3793: chant.yml no longer runs `npm run prepack` per lexicon. One job
  // runs every lexicon's generate and bundle and caches them; validate runs
  // the rest (validate, build) on that cache. Together, with the gate armed,
  // they must cover every step a prepack names.
  it("the chant workflow runs every prepack step under the gate, validate's steps in the validate job", () => {
    const ARTIFACTS = /scripts\/ci-lexicon-artifacts\.sh(?:\s+--steps\s+([\w,]+))?/;
    const covered = new Set<string>();
    const stepsIn = (name: string) => {
      const job = chant.jobs[name];
      const out = new Set<string>();
      for (const step of stepsRunning(job, ARTIFACTS)) {
        if (envOf(job, step, "CHANT_RELEASE_GATE") !== gate) continue;
        const m = ARTIFACTS.exec(step.run!)!;
        for (const s of m[1] ? m[1].split(",") : ["generate", "bundle", "validate", "build"]) out.add(s);
      }
      return out;
    };
    for (const name of Object.keys(chant.jobs)) for (const s of stepsIn(name)) covered.add(s);
    const aws = JSON.parse(readFileSync(join(root, "lexicons", "aws", "package.json"), "utf8")) as { scripts: Record<string, string> };
    // A lexicon with floors runs its build under release-floors.ts --pack;
    // scripts/ci-lexicon-artifacts.sh runs that as its `build` step.
    const prepack = aws.scripts.prepack
      .split("&&")
      .map((x) => x.trim().replace(/^tsx \.\.\/\.\.\/scripts\/release-floors\.ts --lexicon \S+ --pack /, "").replace(/^npm run /, ""));
    expect(prepack).toEqual(expect.arrayContaining(["generate", "validate"]));
    expect([...covered].sort()).toEqual(expect.arrayContaining(prepack));
    expect([...stepsIn("validate")]).toEqual(expect.arrayContaining(["validate"]));
  });
});

// Unit tests only on every change (2026-10-23). A pull request and a push to
// main, and each merge queue group, run the lexicon artifacts, core's typecheck and the unit tests. Every
// other job and suite runs only when a person starts it. On GitHub that is a
// workflow_dispatch, locally a person typing `run` at scripts/human-gate.sh.
describe("pull request and push CI run the unit tests only", () => {
  it("chant.yml runs typecheck and unit tests on a push or pull request, everything else by hand", () => {
    const chant = workflow("chant.yml");
    expect(Object.keys(chant.on).sort()).toEqual(["merge_group", "pull_request", "push", "workflow_dispatch"]);
    const always = ["check", "lexicon-artifacts", "test", "test-shard", "typecheck"];
    for (const [name, job] of Object.entries(chant.jobs)) {
      if (always.includes(name)) expect(job.if ?? "").not.toMatch(/workflow_dispatch/);
      else expect(job.if).toBe("github.event_name == 'workflow_dispatch'");
    }
    expect(stepsRunning(chant.jobs["test-shard"], /npx vitest run --project unit --shard=/)).toHaveLength(1);
    expect(stepsRunning(chant.jobs.check, /./).map((s) => s.run).filter((r) => /tsc7\.sh/.test(r!))).toEqual([
      "scripts/tsc7.sh --noEmit --declaration false --declarationMap false -p packages/core/tsconfig.json",
    ]);
    for (const name of always) {
      expect(stepsRunning(chant.jobs[name], /--project e2e|ci-observability-binaries\.sh test|smoke\.sh|docker build/)).toEqual([]);
    }
    expect(stepsRunning(chant.jobs.typecheck, /./).map((s) => s.run)).toContain("npx tsx scripts/typecheck.ts");
    expect(chant.jobs.typecheck.needs).toEqual(["lexicon-artifacts"]);
    expect(chant.jobs.test.needs).toEqual(["test-shard"]);
  });

  it("ci.green requires check, typecheck and test and nothing else", () => {
    const declaration = JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf8")) as {
      ci: { green: { branch: string; phases: Record<string, { runs: string[]; build?: string }>; require: string[] } };
    };
    expect(declaration.ci.green.branch).toBe("main");
    expect(declaration.ci.green.require).toEqual(["check", "typecheck", "test"]);
    expect(Object.keys(declaration.ci.green.phases).sort()).toEqual(["check", "test", "typecheck"]);
  });

  it("the suites, docs checks and large-suite workflows start only from a dispatch", () => {
    for (const file of ["release-suites.yml", "docs-check.yml", "large-suites.yml", "helm-survey.yml"]) {
      expect(Object.keys(workflow(file).on)).toEqual(["workflow_dispatch"]);
    }
    expect(stepsRunning(workflow("release-suites.yml").jobs.e2e, /npx vitest run --project e2e/)).toHaveLength(1);
  });

  const gateScript = join(root, "scripts", "human-gate.sh");
  const runGate = (env: Record<string, string>) =>
    spawnSync("bash", [gateScript, "test-e2e"], {
      env: { PATH: process.env.PATH ?? "", ...env },
      input: "run\n",
      encoding: "utf8",
    });

  it("the local gate stops anything without a terminal, with exit 3", () => {
    const result = runGate({});
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("STOP: `test-e2e` is a large suite");
    expect(result.stderr).toContain("A coding agent must not run it");
  });

  it("the local gate lets GitHub's own runs through", () => {
    expect(runGate({ GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "1" }).status).toBe(0);
    expect(runGate({ GITHUB_ACTIONS: "true" }).status).toBe(3);
  });
});
