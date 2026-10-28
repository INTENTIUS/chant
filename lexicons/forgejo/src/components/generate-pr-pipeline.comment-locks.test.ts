/** `/<product> lock` and `/<product> unlock` on Forgejo (#4588): the GitHub generator's comment jobs, reading Forgejo's `is_pull`, with no author check. */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateForgejoPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
];

const WORDS = { product: "plywood", commands: { lock: "lock" as const, unlock: "unlock" as const } };

type Doc = { jobs: Record<string, { if?: string; steps: Array<{ run?: string }> }> };

describe("the Forgejo workflow's lock and unlock comments", () => {
  const doc = parseYAML(generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { locks: "plan", words: WORDS } }).yaml) as Doc;

  test("each comment job reads is_pull and runs on forgejo", () => {
    expect(doc.jobs["comment-lock"]!.if).toContain("github.event.is_pull");
    expect(doc.jobs["comment-lock"]!.if).not.toContain("author_association");
    expect(doc.jobs["comment-lock"]!.steps.some((s) => s.run === 'chant lock --keep --pr "$PR_NUMBER" --forge forgejo')).toBe(true);
    expect(doc.jobs["comment-unlock"]!.steps.some((s) => s.run === 'chant unlock --pr "$PR_NUMBER"')).toBe(true);
  });
});
