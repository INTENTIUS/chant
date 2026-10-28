/**
 * The agent jobs on GitLab (#4616): the comment agent in a pipeline of the
 * default branch started with the merge request and the ask, the drift agent
 * after a drift check, the push token scoped to the push job's environment,
 * and a runner as tags.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { generateGitlabOpPipeline } from "./generate-op-pipeline";

type Job = { rules?: Array<{ if?: string; when?: string }>; needs?: Array<{ job: string }>; tags?: string[]; timeout?: string; environment?: { name: string }; script: string[]; artifacts?: { paths?: string[]; reports?: Record<string, string> }; variables?: Record<string, string> };
const gen = (spec: ScheduledOpSpec) => {
  const out = generateGitlabOpPipeline([spec]);
  return { doc: parseYAML(out.files[0]!.yaml) as unknown as Record<string, Job>, yaml: out.files[0]!.yaml };
};

describe("the comment agent on GitLab", () => {
  const { doc, yaml } = gen({ name: "chant-agent", runner: ["agents"], agent: { on: "comment", comment: "/chant agent", maxRuns: 4 } });
  const agent = doc["chant-agent"]!;
  const push = doc["chant-agent-push"]!;

  test("runs in a pipeline of the default branch started with the merge request and the ask", () => {
    expect(agent.rules?.[0]?.if).toContain("$CHANT_AGENT_PR =~ /^[0-9]+$/");
    expect(agent.rules?.[0]?.if).toContain("$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH");
    expect(agent.tags).toEqual(["agents"]);
    expect(agent.timeout).toBe("45 minutes");
  });

  test("the agent job drops every forge token before the decision and the model", () => {
    const unset = agent.script.findIndex((l) => l.startsWith("unset "));
    const prepare = agent.script.findIndex((l) => l.includes("chant agent prepare"));
    expect(unset).toBeGreaterThan(-1);
    expect(unset).toBeLessThan(prepare);
    expect(agent.script.at(-1)).toContain("chant agent run --forge gitlab");
    expect(agent.artifacts?.paths).toEqual([".chant/agent"]);
  });

  test("the push job runs under its own environment with the push token", () => {
    expect(push.environment?.name).toBe("chant-agent-push");
    expect(push.needs).toEqual([{ job: "chant-agent", artifacts: true }]);
    expect(push.script.join("\n")).toContain('export CHANT_GITLAB_TOKEN="$CHANT_FORGE_TOKEN"');
    expect(push.script.at(-1)).toContain("chant agent land --forge gitlab");
    expect(yaml).toContain("scope it to environment chant-agent-push");
  });
});

describe("the drift agent on GitLab", () => {
  const { doc } = gen({ name: "drift-app", trigger: { kind: "cron", schedule: "0 6 * * *" }, agent: { on: "drift" } });

  test("the drift check keeps its output and a dotenv that says it found drift", () => {
    const op = doc["drift-app"]!;
    expect(op.script.join("\n")).toContain('echo "CHANT_AGENT_DRIFT=1"');
    expect(op.artifacts?.reports).toEqual({ dotenv: ".chant/agent/drift.env" });
  });

  test("the agent and push jobs follow it whatever it exited, and stop when it found none", () => {
    const agent = doc["drift-app-agent"]!;
    expect(agent.needs).toEqual([{ job: "drift-app", artifacts: true }]);
    expect(agent.rules?.every((r) => r.when === "always")).toBe(true);
    expect(agent.script[0]).toContain('"${CHANT_AGENT_DRIFT:-0}" != "1"');
    expect(doc["drift-app-agent-push"]!.script[0]).toContain("decision.json");
  });

  test("a runner group is refused", () => {
    expect(() => gen({ name: "drift-app", trigger: { kind: "cron", schedule: "0 6 * * *" }, runner: { group: "infra" } })).toThrow(/runner group/);
  });
});

// #4619: a member's drift Op runs in the member's directory, and its artifact keeps the drift there.
describe("the drift agent of a workspace member on GitLab", () => {
  const out = generateGitlabOpPipeline([{ name: "drift-app", trigger: { kind: "cron", schedule: "0 6 * * *" }, agent: { on: "drift", maxCostUsd: 4 } }], { member: { name: "app", dir: "stacks/app" } });
  const doc = parseYAML(out.files[0]!.yaml) as unknown as Record<string, Job>;
  const op = doc["app-drift-app"]!;
  const agent = doc["app-drift-app-agent"]!;
  const push = doc["app-drift-app-agent-push"]!;

  test("the drift check runs in the member's directory and keeps the drift under it", () => {
    expect(op.script[0]).toBe("cd stacks/app");
    expect(op.artifacts?.paths).toEqual(["stacks/app/.chant/agent"]);
    expect(op.artifacts?.reports).toEqual({ dotenv: "stacks/app/.chant/agent/drift.env" });
  });

  test("the agent and push jobs read the member's own drift output", () => {
    expect(agent.script.some((l) => l.startsWith("cd "))).toBe(false);
    expect(agent.script.find((l) => l.includes("agent prepare"))).toBe("chant agent prepare --forge gitlab --output stacks/app/.chant/agent");
    expect(agent.script.at(-1)).toBe("chant agent run --forge gitlab --output stacks/app/.chant/agent");
    expect(agent.artifacts?.paths).toEqual(["stacks/app/.chant/agent"]);
    expect(push.script[0]).toContain("stacks/app/.chant/agent/decision.json");
    expect(push.script.at(-1)).toBe("chant agent land --forge gitlab --output stacks/app/.chant/agent");
  });

  test("the money limit reaches both jobs and the file's header", () => {
    expect(agent.variables?.CHANT_AGENT_MAX_COST_USD).toBe("4");
    expect(push.variables?.CHANT_AGENT_MAX_COST_USD).toBe("4");
    expect(out.files[0]!.yaml).toContain("and to $4 a day of recorded cost");
  });
});
