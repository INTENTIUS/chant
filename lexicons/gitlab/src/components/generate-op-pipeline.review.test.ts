/**
 * `reviewAgent` on GitLab (#4544): the review job runs in the merge request
 * pipeline with no forge token and keeps its review as an artifact; the note
 * job runs in a pipeline of the default branch, checks nothing out, and posts
 * with the protected token.
 */

import { describe, expect, test } from "vitest";
import { FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";
import { parseYAML } from "@intentius/chant/yaml";
import type { ComponentPipelineOptions, ScheduledOpSpec } from "@intentius/chant/lexicon";
import { generateGitlabOpPipeline } from "./generate-op-pipeline";

const spec: ScheduledOpSpec = { name: "pr-review", trigger: { kind: "pull_request" }, reviewAgent: true };

function generated(specs: ScheduledOpSpec[] = [spec], options: ComponentPipelineOptions = {}) {
  const out = generateGitlabOpPipeline(specs, options);
  return { out, doc: parseYAML(out.files[0].yaml) as Record<string, Record<string, unknown>> };
}

const ruleText = (job: Record<string, unknown>): string => JSON.stringify(job.rules);
const inMergeRequestPipeline = (job: Record<string, unknown>): boolean => ruleText(job).includes("merge_request_event");

describe("generateGitlabOpPipeline: reviewAgent", () => {
  test("emits the review job and its note job", () => {
    const { out, doc } = generated();
    expect(out.jobs.map((j) => j.jobName)).toEqual(["pr-review"]);
    expect(Object.keys(doc)).toEqual(["stages", "pr-review", "pr-review-note"]);
    expect(out.files[0].yaml).toContain('CHANT_REVIEW_NOTES="1"');
    expect(out.files[0].yaml).toContain("protected, masked CI/CD variable");
  });

  test("the review job runs in the merge request pipeline, drops every forge token first and keeps the review as an artifact", () => {
    const { doc } = generated();
    const review = doc["pr-review"];
    expect(inMergeRequestPipeline(review)).toBe(true);
    const script = review.script as string[];
    expect(script[0]).toBe(`unset ${FORGE_TOKEN_VARS.join(" ")}`);
    expect(script).toContain("chant run pr-review");
    expect(review.variables).toEqual({ CHANT_REVIEW_DIR: ".chant/review" });
    expect(review.artifacts).toEqual({ paths: [".chant/review"], expire_in: "7 days" });
  });

  test("no job of the merge request pipeline holds a write token", () => {
    const { doc } = generated([spec, { name: "lint", trigger: { kind: "pull_request" } }], { variables: { FOO: "bar" } });
    const writeTokens = ["CHANT_FORGE_TOKEN", "CHANT_RUNNER_KEY", "GITLAB_TOKEN", "CHANT_GITLAB_TOKEN"];
    for (const [name, job] of Object.entries(doc)) {
      if (name === "stages" || name === "variables" || !inMergeRequestPipeline(job)) continue;
      const text = JSON.stringify({ variables: job.variables ?? {}, script: (job.script as string[]).filter((l) => !l.startsWith("unset ")) });
      for (const token of writeTokens) expect(text, `${name} ${token}`).not.toContain(token);
    }
    expect(Object.keys(doc.variables ?? {})).toEqual(["FOO"]);
  });

  test("the note job runs only in a pipeline of the default branch, checks nothing out and treats the artifact as data", () => {
    const { doc } = generated([{ ...spec, trigger: { kind: "pull_request", branches: ["main", "release"] } }]);
    const note = doc["pr-review-note"];
    expect(inMergeRequestPipeline(note)).toBe(false);
    expect(note.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE =~ /^(schedule|web|api|trigger)$/ && $CHANT_REVIEW_NOTES == "1" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }]);
    expect(note.variables).toEqual({ GIT_STRATEGY: "none" });
    const script = (note.script as string[]).join("\n");
    expect(script).toMatch(/npm install .*@intentius\/chant@\d+\.\d+\.\d+/);
    expect(script).toContain("postOpenReviewNotes");
    expect(script).toContain('const branches = ["main","release"]');
    expect(script).toContain('job: "pr-review", artifactDir: ".chant/review", op: "pr-review"');
    expect(script).not.toContain("chant run");
  });

  test("a workspace member's review keeps its artifact under the member's directory", () => {
    const { doc } = generated([spec], { member: { name: "web", dir: "apps/web" } });
    expect(doc["web-pr-review"].artifacts).toEqual({ paths: ["apps/web/.chant/review"], expire_in: "7 days" });
    expect((doc["web-pr-review-note"].script as string[]).join("\n")).toContain('job: "web-pr-review", artifactDir: "apps/web/.chant/review"');
  });

  test("is refused on a trigger with no merge request, a posting finding-mode, or a write scope", () => {
    expect(() => generateGitlabOpPipeline([{ ...spec, trigger: { kind: "push" } }])).toThrow(/sets reviewAgent.*trigger is "push"/s);
    expect(() => generateGitlabOpPipeline([{ ...spec, findingMode: "comment" }])).toThrow(/findingMode "comment".*must be "report"/s);
    expect(() => generateGitlabOpPipeline([{ ...spec, permissions: { "pull-requests": "write" } }])).toThrow(/"pull-requests: write"/);
  });

  test("an Op without it generates as before", () => {
    const out = generateGitlabOpPipeline([{ name: "pr-review", trigger: { kind: "pull_request" }, findingMode: "comment" }]);
    expect(out.jobs.map((j) => j.jobName)).toEqual(["pr-review"]);
    expect(out.files[0].yaml).not.toContain("CHANT_REVIEW_NOTES");
  });
});
