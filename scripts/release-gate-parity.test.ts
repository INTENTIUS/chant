/**
 * The `chant` workflow must run the lexicon prepacks under the same release
 * gate `npm publish` arms (#1481).
 *
 * release-preflight.sh refuses to tag a commit whose `chant` run is not green,
 * on the premise that green means publishable. That premise held only if the
 * checks publish performs are a subset of the checks CI performs. They were
 * not: CHANT_RELEASE_GATE=1 was set solely on the publish step, so the
 * surface-snapshot check and the pinned-spec refusal ran in exactly the one
 * place a green build had never exercised. This pins the workflows to each
 * other so the gap cannot reopen without a failing test.
 *
 * Since #2817 publish does not re-run the suite: its gate is that same green
 * `chant` run, checked through the API by scripts/publish-verify-ci.sh. Since
 * CI went unit-only (2026-10-23) that run is core's typecheck and the unit
 * tests, the gate runs on every tag push, and the validate job that arms the
 * release gate runs only by hand.
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
  const publish = workflow("publish.yml");
  const chant = workflow("chant.yml");

  const publishStep = stepsRunning(publish.jobs.publish, /publish-packages\.sh/);
  it("the publish step arms CHANT_RELEASE_GATE", () => {
    expect(publishStep).toHaveLength(1);
    expect(envOf(publish.jobs.publish, publishStep[0], "CHANT_RELEASE_GATE")).toBe("1");
  });
  const gate = envOf(publish.jobs.publish, publishStep[0], "CHANT_RELEASE_GATE");

  // #2817: publish no longer runs the suite and the prepacks again. Its gate
  // is the chant run on the released commit, which must therefore arm the
  // release gate itself (the next test).
  it("publish.yml's test gate requires the released commit's chant run to have passed", () => {
    const steps = stepsRunning(publish.jobs.test, /scripts\/publish-verify-ci\.sh/);
    expect(steps).toHaveLength(1);
    expect(publish.jobs.publish.needs).toEqual(["test"]);
    expect(publish.jobs.publish.if).toMatch(/needs\.test\.result == 'success'/);
    expect((publish.jobs["release-publish"] as Job).needs).toEqual(["test"]);
    expect((publish.jobs["release-publish"] as Job).if).toMatch(/needs\.test\.result == 'success'/);
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
    const prepack = aws.scripts.prepack.split("&&").map((x) => x.trim().replace(/^npm run /, ""));
    expect(prepack).toEqual(expect.arrayContaining(["generate", "validate"]));
    expect([...covered].sort()).toEqual(expect.arrayContaining(prepack));
    expect([...stepsIn("validate")]).toEqual(expect.arrayContaining(["validate"]));
  });

  it("a failed tag release deletes its tag", () => {
    const untag = publish.jobs.untag;
    expect(untag).toBeDefined();
    expect(untag.needs).toEqual(expect.arrayContaining(["test", "publish"]));
    expect(untag.if).toMatch(/always\(\)/);
    expect(untag.if).toMatch(/needs\.publish\.result/);
    expect(untag.if).toMatch(/needs\.test\.result/);
    // #3191: the deletion goes through release-untag.sh, which keeps the tag
    // once any package of the release is on npm.
    expect(stepsRunning(untag, /scripts\/release-untag\.sh/)).toHaveLength(1);
    expect(readFileSync(join(root, "scripts", "release-untag.sh"), "utf8")).toMatch(/git push origin ":refs\/tags\//);
  });

  // 2026-10-23: the release gates on the unit tests and nothing else. The
  // trusted-publisher audit (#3191) is gone from publish.yml.
  it("publish gates on the unit tests only", () => {
    expect(Object.keys(publish.jobs).sort()).toEqual(["publish", "release-publish", "test", "untag"]);
    expect(publish.jobs.test.if).toBeUndefined();
  });

  // #3903: with CHANT_STAGED_PUBLISH=1 the publish step stages every
  // package under `next`, then moves `latest` with `npm dist-tag add`. Over
  // OIDC that needs the id-token permission and an npm whose dist-tag does
  // the exchange (12.2.0 and later). The trusted-publisher records also need
  // "Allow npm dist-tag", which is set on npmjs.com, not here (#3904), so the
  // switch is a repository variable, off until those records allow it.
  it("the publish job can move dist-tags over OIDC, behind a repository variable", () => {
    expect(publish.jobs.publish.permissions?.["id-token"]).toBe("write");
    expect(envOf(publish.jobs.publish, publishStep[0], "CHANT_STAGED_PUBLISH")).toBe("${{ vars.CHANT_STAGED_PUBLISH }}");
    const script = readFileSync(join(root, "scripts", "publish-packages.sh"), "utf8");
    expect(script).toMatch(/npm@12\.2\.0/);
    expect(script).toMatch(/Allow npm dist-tag/);
  });

  // #3027: the gate waits for the chant run; a gate that ran out of time
  // waiting has not shown the release is bad, so the tag stays.
  it("a gate that only timed out waiting keeps the tag", () => {
    const test = publish.jobs.test as Job & { outputs?: Record<string, string> };
    expect(test.outputs?.gate).toMatch(/steps\.verify\.outputs\.outcome/);
    expect(publish.jobs.untag.if).toMatch(/needs\.test\.outputs\.gate != 'timeout'/);
  });
});

// Unit tests only on every change (2026-10-23). A pull request and a push to
// main run the lexicon artifacts, core's typecheck and the unit tests. Every
// other job and suite runs only when a person starts it. On GitHub that is a
// workflow_dispatch, locally a person typing `run` at scripts/human-gate.sh.
describe("pull request and push CI run the unit tests only", () => {
  it("chant.yml runs typecheck and unit tests on a push or pull request, everything else by hand", () => {
    const chant = workflow("chant.yml");
    expect(Object.keys(chant.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    const always = ["check", "lexicon-artifacts", "test", "test-shard"];
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
    expect(chant.jobs.test.needs).toEqual(["test-shard"]);
  });

  it("ci.green requires check and test and nothing else", () => {
    const declaration = JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf8")) as {
      ci: { green: { branch: string; phases: Record<string, { runs: string[]; build?: string }>; require: string[] } };
    };
    expect(declaration.ci.green.branch).toBe("main");
    expect(declaration.ci.green.require).toEqual(["check", "test"]);
    expect(Object.keys(declaration.ci.green.phases).sort()).toEqual(["check", "test"]);
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
