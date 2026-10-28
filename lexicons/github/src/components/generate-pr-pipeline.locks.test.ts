/**
 * The pull-request workflow with `ci.locks: plan` (#4327): a lock job after
 * the plan runs `chant lock --from-report` and an unlock job runs `chant
 * unlock` when the pull request closes. Both check out the target branch's
 * commit. Without the option the workflow is unchanged.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGithubPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
];

interface Step { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { if?: string; needs?: string[]; permissions: Record<string, string>; steps: Step[] }
type Doc = { on: Record<string, unknown>; jobs: Record<string, Job> };

const gen = (prLoop: Record<string, unknown>) => parseYAML(generateGithubPipeline(ESTATE, { env: "prod", prLoop }).yaml) as Doc;

describe("the GitHub workflow with ci.locks: plan", () => {
  const doc = gen({ locks: "plan" });

  test("adds a lock job and an unlock job, and fires on close", () => {
    expect(Object.keys(doc.jobs)).toEqual(["plan", "plan-note", "lock", "unlock", "record"]);
    expect(doc.on.pull_request).toEqual({ branches: ["main"], types: ["opened", "synchronize", "reopened", "closed"] });
    expect(doc.jobs.plan!.if).toBe("github.event_name == 'pull_request' && github.event.action != 'closed'");
  });

  test("the lock job needs the plan, takes its report and runs chant lock --from-report from the base commit", () => {
    const job = doc.jobs.lock!;
    expect(job.needs).toEqual(["plan"]);
    expect(job.steps[0]!.with!.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(job.steps.some((s) => s.run?.includes("needs.plan.outputs"))).toBe(true);
    const lock = job.steps.find((s) => s.run?.startsWith("chant lock"))!;
    expect(lock.run).toBe('chant lock --from-report .chant/pr/pr-plan.json --pr "$PR_NUMBER" --head "$HEAD_SHA" --stage plan --forge github');
    expect(lock.env!.PR_NUMBER).toBe("${{ github.event.pull_request.number }}");
    expect(job.permissions).toEqual({ contents: "write", "pull-requests": "read", statuses: "write" });
  });

  test("the unlock job runs chant unlock on close, from the base commit, and runs no head code", () => {
    const job = doc.jobs.unlock!;
    expect(job.if).toBe("github.event_name == 'pull_request' && github.event.action == 'closed'");
    expect(job.steps[0]!.with!.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(job.steps.find((s) => s.run?.startsWith("chant unlock"))!.run).toBe('chant unlock --pr "$PR_NUMBER"');
  });

  test("without ci.locks the workflow has neither job and fires on the default pull request types", () => {
    const plain = generateGithubPipeline(ESTATE, { env: "prod", prLoop: {} }).yaml;
    expect(parseYAML(plain)).toMatchObject({ on: { pull_request: { branches: ["main"] } } });
    expect(plain).not.toContain("closed");
    expect(plain).not.toContain("chant lock");
    expect(plain).not.toContain("chant unlock");
  });
});

describe("a product's words (plywood#22)", () => {
  test("the lock and unlock lines run through the product's bin, so its job image needs no chant on PATH", () => {
    const doc = gen({ locks: "plan", words: { product: "plywood", bin: "npx --no-install plywood" } });
    const lock = doc.jobs.lock!.steps.find((s) => s.run?.includes(" lock --from-report"))!;
    expect(lock.run).toBe('npx --no-install plywood lock --from-report .chant/pr/pr-plan.json --pr "$PR_NUMBER" --head "$HEAD_SHA" --stage plan --forge github');
    const unlock = doc.jobs.unlock!.steps.find((s) => s.run?.includes(" unlock --pr"))!;
    expect(unlock.run).toBe('npx --no-install plywood unlock --pr "$PR_NUMBER"');
  });
});

describe("with a pull request environment too", () => {
  test("the pull_request types and the plan condition are the same as with the environment alone", () => {
    const both = gen({ locks: "plan", prEnvironment: true });
    const env = gen({ prEnvironment: true });
    expect(both.on.pull_request).toEqual(env.on.pull_request);
    expect(both.jobs.plan!.if).toBe(env.jobs.plan!.if);
    expect(Object.keys(both.jobs)).toContain("lock");
    expect(Object.keys(both.jobs)).toContain("env-down");
  });
});
