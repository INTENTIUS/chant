/**
 * The agent jobs on Forgejo (#4616): github's jobs in the Forgejo dialect,
 * with the commenter's access asked of the forge, and a runner a label.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { generateForgejoOpPipeline } from "./generate-op-pipeline";

const doc = (spec: ScheduledOpSpec) => parseYAML(generateForgejoOpPipeline([spec]).files[0]!.yaml) as unknown as { jobs: Record<string, { if?: string; "runs-on"?: unknown; steps: Array<{ run?: string; env?: Record<string, string> }> }> };

describe("the comment agent on Forgejo", () => {
  const d = doc({ name: "chant-agent", runner: "agents", agent: { on: "comment", comment: "/chant agent" } });

  test("answers a comment on a pull request with no author association to read", () => {
    const agent = d.jobs["chant-agent"]!;
    expect(agent.if).toContain("github.event.is_pull");
    expect(agent.if).not.toContain("author_association");
    expect(agent["runs-on"]).toBe("agents");
  });

  test("the push job hands the forge client its token", () => {
    const land = d.jobs["chant-agent-push"]!.steps.at(-1)!;
    expect(land.run).toContain("chant agent land --forge forgejo");
    expect(land.env?.CHANT_FORGEJO_TOKEN).toBeDefined();
  });

  test("refuses a runner group, which only GitHub has", () => {
    expect(() => doc({ name: "drift-app", trigger: { kind: "cron", schedule: "0 6 * * *" }, runner: { group: "infra" } })).toThrow(/runner group/);
  });
});
