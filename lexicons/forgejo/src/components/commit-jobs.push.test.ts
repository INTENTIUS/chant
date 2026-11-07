/** #4749 on Forgejo: GitHub's commit jobs under the Forgejo dialect, with the job's own token. */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { generateForgejoOpPipeline } from "./generate-op-pipeline";

type Job = { steps: Array<{ name?: string; env?: Record<string, string>; run?: string }> };

describe("commit jobs with jobToken on Forgejo (#4749)", () => {
  test("push with the job's token through the Forgejo client, then run after", () => {
    const spec: ScheduledOpSpec = { name: "chant-fmt", commit: { on: "comment", comment: "/chant fmt", command: ["tofu", "fmt"], allowed: ["infra/"], jobToken: true, after: ["echo pushed"] } };
    const doc = parseYAML(generateForgejoOpPipeline([spec]).files[0]!.yaml) as { jobs: Record<string, Job> };
    const steps = doc.jobs["chant-fmt-push"]!.steps;
    const land = steps.find((s) => s.name === "Push the change to the pull request")!;
    expect(land.env).toMatchObject({ CHANT_FORGEJO_TOKEN: "${{ github.token }}" });
    expect(steps.at(-1)!.run).toContain("echo pushed");
  });
});
