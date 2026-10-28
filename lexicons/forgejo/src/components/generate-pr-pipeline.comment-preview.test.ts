/** The preview comment on Forgejo (#4620): the GitHub generator's jobs, reading Forgejo's `is_pull`, with no author check. */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateForgejoPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
];

const WORDS = { product: "plywood", stages: { plan: "preview", apply: "up" }, commands: { preview: "plan" as const } };

type Doc = { jobs: Record<string, { if?: string; permissions?: Record<string, string>; steps: Array<{ run?: string }> }> };

describe("the Forgejo workflow's preview comment", () => {
  const doc = parseYAML(generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { previewComment: true, words: WORDS } }).yaml) as Doc;

  test("the preview job reads is_pull, holds a read token, and the note job posts on forgejo", () => {
    expect(doc.jobs["comment-preview"]!.if).toContain("github.event.is_pull");
    expect(doc.jobs["comment-preview"]!.if).not.toContain("author_association");
    expect(doc.jobs["comment-preview"]!.permissions).toEqual({ contents: "read" });
    expect(doc.jobs["comment-preview-note"]!.steps.at(-1)!.run).toBe('chant components pr-post --pr "$PR_NUMBER" --head "$HEAD_SHA" --env prod --output .chant/pr --forge forgejo --result "$PLAN_RESULT"');
  });
});
