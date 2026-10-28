/**
 * The agent jobs (#4616): `ScheduledOpSpec.agent` and `runner`. The model's
 * job holds a read token and the model's key; only the push job writes.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { generateGithubOpPipeline } from "./generate-op-pipeline";

interface Step {
  id?: string;
  name?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  needs?: string;
  if?: string;
  "runs-on"?: unknown;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}
interface Doc {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const gen = (spec: ScheduledOpSpec) => {
  const out = generateGithubOpPipeline([spec]);
  return { doc: parseYAML(out.files[0]!.yaml) as unknown as Doc, name: out.files[0]!.name, jobs: out.jobs };
};

const COMMENT: ScheduledOpSpec = { name: "chant-agent", agent: { on: "comment", comment: "/chant agent", maxRuns: 3, timeout: 20 } };

describe("the comment agent", () => {
  const { doc, name } = gen(COMMENT);
  const agent = doc.jobs["chant-agent"]!;
  const push = doc.jobs["chant-agent-push"]!;

  test("is a workflow of its own on pull request comments from a writer", () => {
    expect(name).toBe("chant-agent.yml");
    expect(doc.on).toEqual({ issue_comment: { types: ["created"] } });
    expect(agent.if).toContain("startsWith(github.event.comment.body, '/chant agent ')");
    expect(agent.if).toContain("author_association");
  });

  test("the agent job reads, stops at its timeout, and runs the model with its key and no forge token", () => {
    expect(agent.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(agent["timeout-minutes"]).toBe(35);
    expect(agent.env).toMatchObject({ CHANT_AGENT_NAME: "chant-agent", CHANT_AGENT_ON: "comment", CHANT_AGENT_MAX_RUNS: "3", CHANT_AGENT_TIMEOUT: "20" });
    const run = agent.steps.at(-1)!;
    expect(run.id).toBe("chant-agent");
    expect(run.env).toEqual({ ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" });
    expect(run.run).toContain("chant agent run --forge github");
    expect(run.run).toContain("trap chant_handover EXIT");
    expect(Object.keys(run.env ?? {}).filter((n) => (FORGE_TOKEN_VARS as readonly string[]).includes(n))).toEqual([]);
    expect(agent.steps[0]!.run).toContain("refs/pull/$PR_NUMBER/head:refs/chant/agent-head");
    expect(agent.steps.some((s) => s.run?.includes("chant agent prepare"))).toBe(true);
  });

  test("the push job holds the write token, takes the change as data and lands it", () => {
    expect(push.needs).toBe("chant-agent");
    expect(push.permissions).toEqual({ contents: "write", "pull-requests": "write", issues: "write" });
    const land = push.steps.at(-1)!;
    expect(land.run).toContain("chant agent land --forge github");
    expect(land.env?.CHANT_AGENT_TOKEN).toBe("${{ github.token }}");
    expect(push.steps.some((s) => s.run?.includes("needs.chant-agent.outputs.report_0"))).toBe(true);
  });

  test("a push token secret replaces the job token, and the runner names where both jobs run", () => {
    const { doc: d } = gen({ ...COMMENT, runner: ["self-hosted", "agents"], agent: { ...COMMENT.agent!, tokenEnv: "AGENT_PUSH_TOKEN" } });
    expect(d.jobs["chant-agent"]!["runs-on"]).toEqual(["self-hosted", "agents"]);
    expect(d.jobs["chant-agent-push"]!["runs-on"]).toEqual(["self-hosted", "agents"]);
    expect(d.jobs["chant-agent-push"]!.steps.at(-1)!.env?.CHANT_AGENT_TOKEN).toBe("${{ secrets.AGENT_PUSH_TOKEN || github.token }}");
  });

  test("refuses settings no job could run", () => {
    expect(() => gen({ name: "a", agent: { on: "comment" } })).toThrow(/comment/);
  });
});

describe("the drift agent", () => {
  const DRIFT: ScheduledOpSpec = { name: "drift-app", trigger: { kind: "cron", schedule: "0 6 * * *" }, findingMode: "issue", agent: { on: "drift", maxRuns: 1 } };
  const { doc } = gen(DRIFT);
  const op = doc.jobs["drift-app"]!;
  const agent = doc.jobs["drift-app-agent"]!;
  const push = doc.jobs["drift-app-agent-push"]!;

  test("the Op's job keeps its output and says when it found drift", () => {
    const run = op.steps.find((s) => s.id === "chant-run")!;
    expect(run.run).toContain('if [ "$code" -eq 2 ]; then echo "drift=true"');
    expect(run.run).toContain("tee .chant/agent/drift.txt");
    expect(op.outputs?.drift).toBe("${{ steps.chant-run.outputs.drift }}");
  });

  test("the agent job follows it on drift and takes its output", () => {
    expect(agent.needs).toBe("drift-app");
    expect(agent.if).toBe("always() && needs.drift-app.outputs.drift == 'true'");
    expect(agent.steps.some((s) => s.run?.includes("needs.drift-app.outputs.report_0"))).toBe(true);
    expect(agent.env?.CHANT_AGENT_BRANCH).toBe("chant/agent/drift-app");
  });

  test("the push job opens or updates the agent's pull request", () => {
    expect(push.needs).toBe("drift-app-agent");
    expect(push.steps.at(-1)!.name).toBe("Open or update the agent's pull request");
  });

  test("refuses a drift agent on a push trigger", () => {
    expect(() => gen({ ...DRIFT, trigger: { kind: "push" } })).toThrow(/drift agent/);
  });
});

describe("the runner field", () => {
  test("names the Op job's runner, a group included", () => {
    const { doc } = gen({ name: "drift-app", trigger: { kind: "cron", schedule: "0 6 * * *" }, runner: { group: "infra", labels: ["linux"] } });
    expect(doc.jobs["drift-app"]!["runs-on"]).toEqual({ group: "infra", labels: ["linux"] });
    expect(gen({ name: "drift-app", trigger: { kind: "cron", schedule: "0 6 * * *" } }).doc.jobs["drift-app"]!["runs-on"]).toBe("ubuntu-latest");
  });
});
