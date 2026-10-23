/**
 * The pull-request workflow with an apply before merge (#4301, ws-106): a
 * `/chant apply` comment starts the apply job from the default branch's
 * workflow, which checks out the pull request's head and runs `pr-apply
 * --before-merge` through `chant ci run`. A push still records.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { prLoopJobs, pullRequestCheckout } from "@intentius/chant/components/pr-pipeline";
import { generateGithubPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
];

interface Step { name?: string; run?: string; env?: Record<string, string> }
interface Job { if: string; permissions: Record<string, string>; steps: Step[] }

describe("the GitHub workflow with --apply-before-merge", () => {
  const doc = parseYAML(generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyBeforeMerge: true } }).yaml) as { on: Record<string, unknown>; jobs: Record<string, Job> };

  test("listens to new comments beside pull requests and pushes, and keeps the record job on a push", () => {
    expect(doc.on).toEqual({ pull_request: { branches: ["main"] }, push: { branches: ["main"] }, issue_comment: { types: ["created"] } });
    expect(Object.keys(doc.jobs)).toEqual(["plan", "plan-note", "record", "apply"]);
    expect(doc.jobs.record!.if).toBe("github.event_name == 'push'");
  });

  test("the apply runs on a /chant apply comment on a pull request from someone who can write", () => {
    const cond = doc.jobs.apply!.if;
    expect(cond).toContain("github.event_name == 'issue_comment'");
    expect(cond).toContain("github.event.issue.pull_request");
    expect(cond).toContain("startsWith(github.event.comment.body, '/chant apply')");
    expect(cond).toContain("github.event.comment.author_association");
  });

  test("it checks out the pull request's head in its run step and applies before merge with the target branch's commit as the base", () => {
    const step = doc.jobs.apply!.steps.find((s) => s.run?.includes("chant ci run apply"))!;
    const lines = step.run!.trimEnd().split("\n");
    expect(lines[0]).toBe(pullRequestCheckout("github"));
    expect(lines.at(-1)).toBe('chant ci run apply --in-place --base "$BASE_SHA" --pr "$PR_NUMBER" --apply-before-merge --env prod --gate pr-apply --forge github');
    expect(step.env).toMatchObject({ BASE_SHA: "${{ github.sha }}", PR_NUMBER: "${{ github.event.issue.number }}" });
  });

  test("the command chant ci run rebuilds asks pr-apply for the apply before merge", () => {
    const apply = prLoopJobs("github", "prod", { applyBeforeMerge: true }).find((j) => j.jobName === "apply")!;
    expect(apply.command).toBe('chant components pr-apply --before-merge --base "$BASE_SHA" --pr "$PR_NUMBER" --env prod --gate pr-apply --output .chant/pr --forge github --resume .chant/pr-resume/pr-apply.json');
  });

  test("it takes no apply on merge, no wave gate and no build", () => {
    expect(() => prLoopJobs("github", "prod", { applyBeforeMerge: true, applyOnMerge: true })).toThrow(/--apply-on-merge/);
    expect(() => prLoopJobs("github", "prod", { applyBeforeMerge: true, waveGate: "w" })).toThrow(/--wave-gate/);
    expect(() => prLoopJobs("github", "prod", { applyBeforeMerge: true, build: true })).toThrow(/--pr-build/);
  });

  test("the pull request checkout refuses a number that is not one", () => {
    expect(pullRequestCheckout("github")).toMatch(/^echo "\$PR_NUMBER" \| grep -Eq '\^\[0-9\]\+\$' && git fetch --quiet origin "\+refs\/pull\/\$PR_NUMBER\/head:/);
    expect(pullRequestCheckout("gitlab")).toContain("refs/merge-requests/$PR_NUMBER/head");
  });

  test("on Forgejo the comment may also say so with is_pull, and there is no author association", () => {
    const forgejo = parseYAML(generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyBeforeMerge: true, forge: "forgejo" } }).yaml) as { jobs: Record<string, Job> };
    expect(forgejo.jobs.apply!.if).toContain("(github.event.issue.pull_request || github.event.is_pull)");
    expect(forgejo.jobs.apply!.if).not.toContain("author_association");
  });
});
