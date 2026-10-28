/**
 * Stale marking on GitHub (#4628): with staleNotes the note job passes the
 * target branch's commit, and a stale-notes job on a push to the branch
 * runs `pr-post --stale` at the pushed commit with a token that may edit the
 * notes and set the statuses. Written for the ci-products post-merge pass.
 */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGithubPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];
const WORDS = { product: "plywood", stages: { plan: "preview", apply: "up" }, commands: { preview: "plan" as const }, bin: "npx --no-install plywood" };

type Step = { name?: string; run?: string; env?: Record<string, string>; uses?: string };
type Doc = { jobs: Record<string, { if?: string; permissions?: Record<string, string>; steps: Step[] }> };
const gen = (prLoop: Record<string, unknown>) => parseYAML(generateGithubPipeline(ESTATE, { env: "prod", prLoop }).yaml) as Doc;

describe("stale notes on GitHub (#4628)", () => {
  const doc = gen({ words: WORDS, staleNotes: true, previewComment: true });

  test("the note job passes the target branch's commit", () => {
    const post = doc.jobs["plan-note"]!.steps.at(-1)!;
    expect(post.run).toContain('--tip "$TIP_SHA"');
    expect(post.env!.TIP_SHA).toBe("${{ github.event.pull_request.base.sha }}");
  });

  test("a stale-notes job on a push marks the open notes stale, naming the preview comment", () => {
    const job = doc.jobs["stale-notes"]!;
    expect(job.if).toBe("github.event_name == 'push' && startsWith(github.ref, 'refs/heads/')");
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "write", statuses: "write" });
    const step = job.steps.at(-1)!;
    expect(step.run).toBe('npx --no-install plywood components pr-post --stale --tip "$TIP_SHA" --env prod --forge github --preview-comment');
    expect(step.env).toEqual({ TIP_SHA: "${{ github.sha }}", GITHUB_TOKEN: "${{ github.token }}" });
  });

  test("without staleNotes, no job and no tip", () => {
    const plain = gen({ words: WORDS });
    expect(plain.jobs["stale-notes"]).toBeUndefined();
    expect(plain.jobs["plan-note"]!.steps.at(-1)!.run).not.toContain("--tip");
  });
});
