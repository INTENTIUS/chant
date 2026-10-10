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
 * `chant` run, checked through the API by scripts/publish-verify-ci.sh.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = { env?: Record<string, string>; steps?: Step[]; needs?: string[]; if?: string };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

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

const AWS_PREPACK = /npm run --prefix lexicons\/aws prepack/;

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
    expect(publish.jobs.publish.needs).toEqual(expect.arrayContaining(["test"]));
  });

  it("the chant workflow runs the aws prepack under the gate in at least one job", () => {
    // One armed job is enough to turn the workflow red; release-preflight.sh
    // gates on the whole run's conclusion.
    const armed = Object.entries(chant.jobs).filter(([, job]) =>
      stepsRunning(job, AWS_PREPACK).some((step) => envOf(job, step, "CHANT_RELEASE_GATE") === gate),
    );
    expect(armed.map(([name]) => name)).toContain("validate");
  });

  it("a failed tag release deletes its tag", () => {
    const untag = publish.jobs.untag;
    expect(untag).toBeDefined();
    expect(untag.needs).toEqual(expect.arrayContaining(["test", "audit", "publish"]));
    expect(untag.if).toMatch(/always\(\)/);
    expect(untag.if).toMatch(/needs\.publish\.result/);
    expect(untag.if).toMatch(/needs\.test\.result/);
    expect(untag.if).toMatch(/needs\.audit\.result/);
    // #3191: the deletion goes through release-untag.sh, which keeps the tag
    // once any package of the release is on npm.
    expect(stepsRunning(untag, /scripts\/release-untag\.sh/)).toHaveLength(1);
    expect(readFileSync(join(root, "scripts", "release-untag.sh"), "utf8")).toMatch(/git push origin ":refs\/tags\//);
  });

  // #3191: a package with no trusted-publisher record stops the release
  // before anything ships.
  it("publish waits on the trusted-publisher audit", () => {
    expect(stepsRunning(publish.jobs.audit, /scripts\/audit-trusted-publishers\.sh/)).toHaveLength(1);
    expect(publish.jobs.publish.needs).toEqual(expect.arrayContaining(["test", "audit"]));
    expect(publish.jobs.publish.if).toMatch(/needs\.audit\.result == 'success'/);
  });

  // #3027: the gate waits for the chant run; a gate that ran out of time
  // waiting has not shown the release is bad, so the tag stays.
  it("a gate that only timed out waiting keeps the tag", () => {
    const test = publish.jobs.test as Job & { outputs?: Record<string, string> };
    expect(test.outputs?.gate).toMatch(/steps\.verify\.outputs\.outcome/);
    expect(publish.jobs.untag.if).toMatch(/needs\.test\.outputs\.gate != 'timeout'/);
  });
});

// The fast checks run on every change; a large suite runs only when a person
// starts it. On GitHub that is a workflow_dispatch, locally a person typing
// `run` at scripts/human-gate.sh.
describe("large suites run only when a person starts them", () => {
  it("chant.yml runs no end-to-end, binary or Docker suite", () => {
    const chant = workflow("chant.yml");
    for (const name of Object.keys(chant.jobs)) {
      expect(stepsRunning(chant.jobs[name], /--project e2e|ci-observability-binaries\.sh test|smoke\.sh|docker build/)).toEqual([]);
    }
    expect(chant.jobs.test.needs).toEqual(["test-shard"]);
  });

  it("the large-suite workflows and the release gate start only from a dispatch", () => {
    for (const file of ["large-suites.yml", "helm-survey.yml"]) {
      expect(Object.keys(workflow(file).on)).toEqual(["workflow_dispatch"]);
    }
    const gate = workflow("publish.yml").jobs.test.if ?? "";
    expect(gate).toMatch(/github\.event_name == 'workflow_dispatch' && inputs\.verify_ci/);
    expect(gate).not.toMatch(/refs\/tags/);
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
