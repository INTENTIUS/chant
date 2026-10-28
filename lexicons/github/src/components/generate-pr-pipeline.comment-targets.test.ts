/**
 * The preview comment's --target on GitHub (#4626): the preview step runs
 * `pr-plan --comment-targets` with the comment body in CHANT_PREVIEW_COMMENT,
 * and the body never appears in the shell line. Written for the
 * ci-products post-merge pass.
 */
import { expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGithubPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];
const WORDS = { product: "plywood", stages: { plan: "preview", apply: "up" }, commands: { preview: "plan" as const }, bin: "npx --no-install plywood" };

test("the preview step reads the comment from a variable (#4626)", () => {
  const doc = parseYAML(generateGithubPipeline(ESTATE, { env: "prod", prLoop: { previewComment: true, words: WORDS } }).yaml) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> }> };
  const step = doc.jobs["comment-preview"]!.steps.find((s) => s.name === "Preview the members this pull request reaches")!;
  expect(step.run).toContain("npx --no-install plywood ci run plan");
  expect(step.run).toContain("--comment-targets");
  expect(step.env!.CHANT_PREVIEW_COMMENT).toBe("${{ github.event.comment.body }}");
  expect(step.run).not.toContain("comment.body");
  const plan = doc.jobs.plan!.steps.find((s) => s.name === "Plan the members this pull request reaches")!;
  expect(plan.run).not.toContain("--comment-targets");
});
