/**
 * The preview comment's --target on GitLab (#4626): the preview job runs
 * `pr-plan --comment-targets`, which reads CHANT_PREVIEW_COMMENT, a variable
 * of the target-branch pipeline. Written for the ci-products post-merge pass.
 */
import { expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];
const WORDS = { product: "plywood", stages: { plan: "preview", apply: "up" }, commands: { preview: "plan" as const }, bin: "npx --no-install plywood" };

test("the preview job runs pr-plan --comment-targets (#4626)", () => {
  const doc = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { previewComment: true, words: WORDS } }).yaml) as Record<string, { script: string[]; variables: Record<string, string> }>;
  const preview = doc["comment-preview"]!;
  expect(preview.script.join("\n")).toContain("--comment-targets");
  expect(preview.variables).not.toHaveProperty("CHANT_PREVIEW_COMMENT");
  expect(doc.plan!.script.join("\n")).not.toContain("--comment-targets");
});
