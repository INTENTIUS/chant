/**
 * The preview comment's --target on Forgejo (#4626): the GitHub generator's
 * preview step, with the comment body in CHANT_PREVIEW_COMMENT. Written for
 * the ci-products post-merge pass.
 */
import { expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateForgejoPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];
const WORDS = { product: "plywood", stages: { plan: "preview", apply: "up" }, commands: { preview: "plan" as const } };

test("the preview step reads the comment from a variable (#4626)", () => {
  const doc = parseYAML(generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { previewComment: true, words: WORDS } }).yaml) as { jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string> }> }> };
  const step = doc.jobs["comment-preview"]!.steps.find((s) => s.run?.includes("--comment-targets"))!;
  expect(step.env!.CHANT_PREVIEW_COMMENT).toBe("${{ github.event.comment.body }}");
});
