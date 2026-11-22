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
    expect(push.needs).toEqual(["drift-app-agent", "drift-app"]);
    expect(push.if).toBe("always() && needs.drift-app-agent.result == 'success'");
    expect(push.steps.at(-1)!.name).toBe("Open or update the agent's pull request");
  });

  test("the Op's job hands its drift issues to the push job (#5463)", () => {
    const run = op.steps.find((s) => s.id === "chant-run")!;
    expect(run.run).toContain('export CHANT_DRIFT_ISSUE_FILE="$PWD/.chant/agent/drift-issues.txt"');
    expect(run.run).toContain('echo "drift_issues=');
    expect(op.outputs?.drift_issues).toBe("${{ steps.chant-run.outputs.drift_issues }}");
    expect(push.steps.at(-1)!.env?.CHANT_AGENT_DRIFT_ISSUES).toBe("${{ needs.drift-app.outputs.drift_issues }}");
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

// #4619: a member's drift Op runs in the member's directory and hands its output on; the agent job takes it at the root.
describe("the drift agent of a workspace member", () => {
  const out = generateGithubOpPipeline([{ name: "drift-app", trigger: { kind: "cron", schedule: "0 6 * * *" }, findingMode: "issue", agent: { on: "drift", maxCostUsd: 2.5 } }], { member: { name: "app", dir: "stacks/app" } });
  const doc = parseYAML(out.files[0]!.yaml) as unknown as Doc & { jobs: Record<string, Job & { defaults?: { run?: { "working-directory"?: string } } }> };
  const op = doc.jobs["drift-app"]!;
  const agent = doc.jobs["drift-app-agent"]!;

  test("the drift check runs in the member's directory and hands on the member's own output", () => {
    expect(op.defaults?.run?.["working-directory"]).toBe("stacks/app");
    expect(op.steps.find((s) => s.id === "chant-run")!.run).toContain("tee .chant/agent/drift.txt");
  });

  test("the agent job runs at the root and takes that output into its agent directory", () => {
    expect(agent.defaults).toBeUndefined();
    const take = agent.steps.find((s) => s.name === "Take the drift from the drift check")!;
    expect(take.run).toContain("needs.drift-app.outputs.report_0");
    expect(take.run).toContain(" .chant/agent <<");
    expect(agent.steps.some((s) => s.run?.includes("chant agent prepare --forge github --output .chant/agent"))).toBe(true);
    expect(agent.env?.CHANT_AGENT_MAX_COST_USD).toBe("2.5");
  });
});

// #5329: the alert agent, started by the relay's workflow_dispatch and by its schedule.
describe("the alert agent", () => {
  const ALERT: ScheduledOpSpec = { name: "chant-alert-agent", agent: { on: "alert", maxRuns: 4, window: 20 } };
  const { doc, name, jobs } = gen(ALERT);
  const agent = doc.jobs["chant-alert-agent"]!;
  const push = doc.jobs["chant-alert-agent-push"]!;
  const all = [agent, push].flatMap((j) => j.steps.map((s) => s.run ?? "")).join("\n");

  test("is a workflow of its own on workflow_dispatch with no inputs, and on its schedule", () => {
    expect(name).toBe("chant-alert-agent.yml");
    expect(doc.on).toEqual({ schedule: [{ cron: "*/15 * * * *" }], workflow_dispatch: {} });
    expect(jobs[0]!.trigger).toEqual({ kind: "cron", schedule: "*/15 * * * *" });
    expect(gen({ ...ALERT, trigger: { kind: "cron", schedule: "*/5 * * * *" } }).doc.on).toMatchObject({ schedule: [{ cron: "*/5 * * * *" }] });
    expect(() => gen({ ...ALERT, trigger: { kind: "push" } })).toThrow(/alert agent/);
  });

  test("the decision and land steps alone hold the relay key; the model's step holds its key and no forge token", () => {
    expect(agent.if).toBeUndefined();
    expect(agent.needs).toBeUndefined();
    expect(agent.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(agent.env).toMatchObject({ CHANT_AGENT_ON: "alert", CHANT_AGENT_WINDOW: "20", CHANT_AGENT_BRANCH: "chant/agent/chant-alert-agent" });
    const decide = agent.steps.find((s) => s.run?.includes("chant agent prepare"))!;
    expect(decide.env?.CHANT_RELAY_KEY).toBe("${{ secrets.CHANT_RELAY_KEY }}");
    expect(agent.steps.at(-1)!.env).toEqual({ ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" });
    expect(push.steps.at(-1)!.env?.CHANT_RELAY_KEY).toBe("${{ secrets.CHANT_RELAY_KEY }}");
    expect(agent.steps[0]!.run).toContain("chant/lifecycle");
  });

  test("never applies, approves or merges", () => {
    expect(all).not.toMatch(/chant (run|approve)\b|gh pr merge|--admin|\bterraform apply\b|\bpulumi up\b/);
    expect(push.permissions).toEqual({ contents: "write", "pull-requests": "write", issues: "write" });
  });
});

// #5357: the failed-apply and scheduled agents, on workflow_dispatch and their schedule, with the settings' digest on every line.
describe("the failed-apply and scheduled agents", () => {
  const FAILED: ScheduledOpSpec = { name: "chant-apply-failed-agent", agent: { on: "apply-failed", maxRuns: 2 } };
  const SCHEDULE: ScheduledOpSpec = { name: "chant-versions", trigger: { kind: "cron", schedule: "0 7 * * 1" }, agent: { on: "schedule", task: "Raise the provider pins.", maxRuns: 1 } };

  test("are workflows of their own; a scheduled agent needs its cron", () => {
    expect(gen(FAILED).doc.on).toEqual({ schedule: [{ cron: "*/15 * * * *" }], workflow_dispatch: {} });
    expect(gen(SCHEDULE).doc.on).toEqual({ schedule: [{ cron: "0 7 * * 1" }], workflow_dispatch: {} });
    expect(() => gen({ ...SCHEDULE, trigger: undefined })).toThrow(/cron trigger/);
    expect(() => gen({ ...FAILED, trigger: { kind: "push" } })).toThrow(/failed-apply agent/);
  });

  test("the failed-apply agent's decision and land steps hold the relay key; the scheduled agent holds none", () => {
    const f = gen(FAILED).doc;
    const decide = f.jobs["chant-apply-failed-agent"]!.steps.find((s) => s.run?.includes("chant agent prepare"))!;
    expect(decide.env?.CHANT_RELAY_KEY).toBe("${{ secrets.CHANT_RELAY_KEY }}");
    expect(f.jobs["chant-apply-failed-agent"]!.steps.at(-1)!.env).toEqual({ ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" });
    const s = gen(SCHEDULE).doc;
    expect(JSON.stringify(s)).not.toContain("CHANT_RELAY_KEY");
    expect(s.jobs["chant-versions"]!.env).toMatchObject({ CHANT_AGENT_ON: "schedule", CHANT_AGENT_TASK: "Raise the provider pins." });
  });

  test("every command line carries the settings' digest, and the checkout notes the default branch", () => {
    for (const spec of [FAILED, SCHEDULE, COMMENT]) {
      const d = gen(spec).doc;
      const lines = Object.values(d.jobs).flatMap((j) => j.steps.map((s) => s.run ?? "")).filter((r) => r.includes("chant agent "));
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const l of lines) expect(l).toMatch(/--digest sha256:[0-9a-f]{64}/);
      expect(Object.values(d.jobs)[0]!.steps[0]!.run).toContain("git remote set-head origin --auto");
    }
  });

  test("never apply, approve or merge", () => {
    for (const spec of [FAILED, SCHEDULE]) {
      const d = gen(spec).doc;
      const all = Object.values(d.jobs).flatMap((j) => j.steps.map((s) => s.run ?? "")).join("\n");
      expect(all).not.toMatch(/chant (run|approve)\b|gh pr merge|--admin|\bterraform apply\b|\bpulumi up\b/);
      expect(d.jobs[`${spec.name}-push`]!.permissions).toEqual({ contents: "write", "pull-requests": "write", issues: "write" });
    }
  });
});

// #5339: the failed-verify agent, on workflow_dispatch and its schedule, with the relay key in the decision and land steps alone.
describe("the failed-verify agent", () => {
  const VERIFY: ScheduledOpSpec = { name: "chant-verify-failed-agent", agent: { on: "verify-failed", maxRuns: 2 } };

  test("is a workflow of its own on workflow_dispatch and its schedule", () => {
    expect(gen(VERIFY).doc.on).toEqual({ schedule: [{ cron: "*/15 * * * *" }], workflow_dispatch: {} });
    expect(() => gen({ ...VERIFY, trigger: { kind: "push" } })).toThrow(/failed-verify agent/);
  });

  test("its decision step holds the relay key, the model's step does not, and every line carries the digest", () => {
    const d = gen(VERIFY).doc;
    const steps = d.jobs["chant-verify-failed-agent"]!.steps;
    expect(steps.find((s) => s.run?.includes("chant agent prepare"))!.env?.CHANT_RELAY_KEY).toBe("${{ secrets.CHANT_RELAY_KEY }}");
    expect(steps.at(-1)!.env).toEqual({ ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" });
    expect(d.jobs["chant-verify-failed-agent"]!.env).toMatchObject({ CHANT_AGENT_ON: "verify-failed" });
    const lines = Object.values(d.jobs).flatMap((j) => j.steps.map((s) => s.run ?? "")).filter((r) => r.includes("chant agent "));
    for (const l of lines) expect(l).toMatch(/--digest sha256:[0-9a-f]{64}/);
  });

  test("never applies, approves, merges or rolls back", () => {
    const d = gen(VERIFY).doc;
    const all = Object.values(d.jobs).flatMap((j) => j.steps.map((s) => s.run ?? "")).join("\n");
    expect(all).not.toMatch(/chant (run|approve)\b|components (promote|rollback)|gh pr merge|--admin|\bterraform apply\b|\bpulumi up\b/);
    expect(d.jobs["chant-verify-failed-agent-push"]!.permissions).toEqual({ contents: "write", "pull-requests": "write", issues: "write" });
  });
});
