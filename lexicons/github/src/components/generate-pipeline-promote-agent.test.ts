/**
 * #5358: a stage's agent steps run in a job before its promote that holds a
 * read token only, and the promote records their answers before it reads
 * them. A stage with none renders as before.
 */

import { describe, expect, test } from "vitest";
import type { PipelinePromoteInput } from "@intentius/chant/lexicon";
import { FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";
import { buildGithubPromoteDoc, generateGithubPipelinePromote } from "./generate-pipeline-promote";

const plain: PipelinePromoteInput = { pipeline: "shop", stages: [{ name: "staging" }, { name: "prod" }] };
const withAgent: PipelinePromoteInput = { pipeline: "shop", stages: [{ name: "staging" }, { name: "prod", agentSteps: { keyEnvs: ["ANTHROPIC_API_KEY"] } }] };

type Job = { permissions?: Record<string, string>; needs?: string; if?: string; steps: Array<{ id?: string; name?: string; env?: Record<string, string>; run?: string }> };
const jobs = (i: PipelinePromoteInput, forge?: "github" | "forgejo") => buildGithubPromoteDoc(i, forge ? { forge } : {}).jobsDoc as Record<string, Job>;

describe("a stage's agent steps on GitHub", () => {
  test("the agent job asks for contents: read alone, and its step starts with every forge token dropped and the model key alone", () => {
    const agent = jobs(withAgent)["agent-prod"]!;
    expect(agent.permissions).toEqual({ contents: "read" });
    const step = agent.steps.find((s) => s.id === "chant-agent-steps")!;
    expect(Object.keys(step.env!).sort()).toEqual(["ANTHROPIC_API_KEY", "CHANT_PROMOTE_RELEASE"]);
    expect(step.env!.ANTHROPIC_API_KEY).toBe("${{ secrets.ANTHROPIC_API_KEY }}");
    const lines = step.run!.split("\n");
    for (const v of FORGE_TOKEN_VARS) expect(lines[0]).toContain(v);
    expect(lines.at(-1)).toBe('chant pipeline agent run --stage prod --release "$CHANT_PROMOTE_RELEASE" --output .chant/agent-steps/prod');
    // The job token reaches the checkout alone.
    expect(JSON.stringify(agent.steps.filter((s) => s.id !== "chant-agent-steps"))).not.toContain("secrets.");
  });

  test("the promote takes the answers, runs when a step failed so it records why, and records before it promotes", () => {
    const promote = jobs(withAgent)["promote-prod"]!;
    expect(promote.needs).toBe("agent-prod");
    expect(promote.if).toBe("${{ !cancelled() && inputs.stage == 'prod' }}");
    const run = promote.steps.at(-1)!.run!.split("\n");
    expect(run).toEqual(['chant pipeline agent record --stage prod --release "$CHANT_PROMOTE_RELEASE" --from .chant/agent-steps/prod', 'chant components promote --to prod --release "$CHANT_PROMOTE_RELEASE"']);
    expect(promote.steps.some((s) => s.name === "Take the answers of prod's agent steps")).toBe(true);
  });

  test("on Forgejo the step drops the tokens too, since its runner ignores permissions", () => {
    const step = jobs(withAgent, "forgejo")["agent-prod"]!.steps.find((s) => s.id === "chant-agent-steps")!;
    expect(step.run!.split("\n")[0]).toContain("CHANT_FORGEJO_TOKEN");
  });

  test("nothing turns on by default: a stage with no agent steps renders as before", () => {
    expect(Object.keys(jobs(plain))).toEqual(["promote-staging", "promote-prod"]);
    expect(generateGithubPipelinePromote(plain)[0]!.yaml).not.toContain("agent");
    expect(Object.keys(jobs(withAgent))).toEqual(["promote-staging", "agent-prod", "promote-prod"]);
  });
});
