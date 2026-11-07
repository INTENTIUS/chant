/** The commit jobs on Forgejo (#4722): GitHub's jobs under the Forgejo dialect. */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { generateForgejoOpPipeline } from "./generate-op-pipeline";

type Job = { if?: string; permissions?: unknown; steps: Array<{ env?: Record<string, string>; run?: string }> };

describe("commit jobs on Forgejo (#4722)", () => {
  test("ask the forge who may write, drop permissions, and push with the token through the Forgejo client", () => {
    const spec: ScheduledOpSpec = { name: "chant-fmt", commit: { on: "comment", comment: "/chant fmt", command: ["tofu", "fmt"], allowed: ["infra/"], tokenEnv: "CHANT_PUSH_TOKEN" } };
    const doc = parseYAML(generateForgejoOpPipeline([spec]).files[0]!.yaml) as { jobs: Record<string, Job> };
    const commit = doc.jobs["chant-fmt"]!;
    expect(commit.if).toContain("github.event.is_pull");
    expect(commit.if).not.toContain("author_association");
    expect(commit.permissions).toBeUndefined();
    const land = doc.jobs["chant-fmt-push"]!.steps.at(-1)!;
    expect(land.env).toMatchObject({ CHANT_FORGEJO_TOKEN: "${{ secrets.CHANT_PUSH_TOKEN }}" });
    expect(land.run).toContain("chant commit land --forge forgejo");
  });

  test("a check commit job follows the check", () => {
    const spec: ScheduledOpSpec = { name: "fmt-check", trigger: { kind: "pull_request" }, commit: { on: "check", command: ["tofu", "fmt"], allowed: ["infra/"], tokenEnv: "CHANT_PUSH_TOKEN" } };
    const doc = parseYAML(generateForgejoOpPipeline([spec]).files[0]!.yaml) as { jobs: Record<string, Job & { needs?: string }> };
    expect(doc.jobs["fmt-check-commit"]!.needs).toBe("fmt-check");
    expect(doc.jobs["fmt-check-commit-push"]).toBeDefined();
  });
});
