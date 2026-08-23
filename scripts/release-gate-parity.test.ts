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
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = { env?: Record<string, string>; steps?: Step[]; needs?: string[]; if?: string };
type Workflow = { jobs: Record<string, Job> };

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

  it("publish.yml's own test gate runs the aws prepack under the same gate", () => {
    const steps = stepsRunning(publish.jobs.test, AWS_PREPACK);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) expect(envOf(publish.jobs.test, step, "CHANT_RELEASE_GATE")).toBe(gate);
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
    expect(untag.needs).toEqual(expect.arrayContaining(["test", "publish"]));
    expect(untag.if).toMatch(/always\(\)/);
    expect(untag.if).toMatch(/needs\.publish\.result/);
    expect(untag.if).toMatch(/needs\.test\.result/);
    const del = stepsRunning(untag, /git push origin ":refs\/tags\//);
    expect(del).toHaveLength(1);
  });
});
