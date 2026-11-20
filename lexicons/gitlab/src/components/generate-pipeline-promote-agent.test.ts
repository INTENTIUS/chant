/**
 * #5358: on GitLab a stage's agent steps run in a job before its promote
 * that drops every forge token, and the promote records their answers.
 */

import { describe, expect, test } from "vitest";
import type { PipelinePromoteInput } from "@intentius/chant/lexicon";
import { GITLAB_DROP_FORGE_TOKENS } from "@intentius/chant/ci-handover";
import { generateGitlabPipelinePromote } from "./generate-pipeline-promote";

const yaml = (i: PipelinePromoteInput) => generateGitlabPipelinePromote(i)[0]!.yaml;

describe("a stage's agent steps on GitLab", () => {
  const out = yaml({ pipeline: "shop", stages: [{ name: "staging", agentSteps: { keyEnvs: ["ANTHROPIC_API_KEY"] } }] });

  test("the agent job drops the forge tokens before it runs the steps, and keeps the answers however it ends", () => {
    const agent = out.slice(out.indexOf("agent-staging:"), out.indexOf("promote-staging:"));
    const drop = agent.indexOf(GITLAB_DROP_FORGE_TOKENS.split(" ")[0]!);
    const runAt = agent.indexOf("pipeline agent run --stage staging");
    expect(drop).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(drop);
    expect(agent).toContain("when: always");
    expect(agent).not.toContain("CHANT_FORGE_TOKEN=");
  });

  test("the promote needs the agent job, runs when it failed, and records before it promotes", () => {
    const promote = out.slice(out.indexOf("promote-staging:"));
    expect(promote).toContain("job: agent-staging");
    expect(promote).toContain("when: always");
    expect(promote.indexOf("pipeline agent record --stage staging")).toBeLessThan(promote.indexOf("components promote --to staging"));
  });

  test("nothing turns on by default", () => {
    expect(yaml({ pipeline: "shop", stages: [{ name: "staging" }] })).not.toContain("agent");
  });
});
