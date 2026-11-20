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
    // #5357: each line ends with the settings' digest.
    const digest = / --digest sha256:[0-9a-f]{64}$/;
    expect(agent.script.find((l) => l.includes("agent prepare"))).toMatch(new RegExp(`^chant agent prepare --forge gitlab --output stacks/app/\\.chant/agent${digest.source}`));
    expect(agent.script.at(-1)).toMatch(new RegExp(`^chant agent run --forge gitlab --output stacks/app/\\.chant/agent${digest.source}`));
    expect(agent.artifacts?.paths).toEqual(["stacks/app/.chant/agent"]);
    expect(push.script[0]).toContain("stacks/app/.chant/agent/decision.json");
    expect(push.script.at(-1)).toMatch(new RegExp(`^chant agent land --forge gitlab --output stacks/app/\\.chant/agent${digest.source}`));
  });

  test("the money limit reaches both jobs and the file's header", () => {
    expect(agent.variables?.CHANT_AGENT_MAX_COST_USD).toBe("4");
    expect(push.variables?.CHANT_AGENT_MAX_COST_USD).toBe("4");
    expect(out.files[0]!.yaml).toContain("and to $4 a day of recorded cost");
  });
});

// #5329: the alert agent, in a pipeline the relay's trigger token starts and in its schedule.
describe("the alert agent on GitLab", () => {
  const { doc, yaml } = gen({ name: "chant-alert-agent", agent: { on: "alert", relayKeyEnv: "OPS_RELAY_KEY" } });
  const agent = doc["chant-alert-agent"]!;
  const push = doc["chant-alert-agent-push"]!;

  test("runs in a trigger pipeline of the default branch, or its own schedule", () => {
    expect(agent.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "trigger" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }, { if: '$CI_PIPELINE_SOURCE == "schedule" && $CHANT_SCHEDULED_OP == "chant-alert-agent"' }]);
    expect(push.rules).toEqual(agent.rules);
    expect(agent.needs).toBeUndefined();
    expect(yaml).toContain("trigger token starts");
  });

  test("the relay key reaches the decision and is gone before the model runs", () => {
    const exp = agent.script.indexOf('export CHANT_RELAY_KEY="$OPS_RELAY_KEY"');
    const prepare = agent.script.findIndex((l) => l.includes("chant agent prepare"));
    const unset = agent.script.indexOf("unset CHANT_RELAY_KEY OPS_RELAY_KEY");
    const run = agent.script.findIndex((l) => l.includes("chant agent run"));
    expect(exp).toBeGreaterThan(-1);
    expect(exp).toBeLessThan(prepare);
    expect(unset).toBeGreaterThan(prepare);
    expect(unset).toBeLessThan(run);
    expect(push.script).toContain('export CHANT_RELAY_KEY="$OPS_RELAY_KEY"');
  });

  test("never applies, approves or merges", () => {
    expect([...agent.script, ...push.script].join("\n")).not.toMatch(/chant (run|approve)\b|merge_when_pipeline_succeeds|\bterraform apply\b|\bpulumi up\b/);
  });
});

// #5357: the failed-apply and scheduled agents, in their schedule or a pipeline of the default branch started by hand.
describe("the failed-apply and scheduled agents on GitLab", () => {
  const failed = gen({ name: "chant-apply-failed-agent", agent: { on: "apply-failed" } });
  const sched = gen({ name: "chant-versions", trigger: { kind: "cron", schedule: "0 7 * * 1" }, agent: { on: "schedule", task: "Raise the pins." } });

  test("run in their schedule or a pipeline of the default branch started by hand, never from a trigger token", () => {
    const rules = failed.doc["chant-apply-failed-agent"]!.rules!;
    expect(rules).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "schedule" && $CHANT_SCHEDULED_OP == "chant-apply-failed-agent"' },
      { if: '$CI_PIPELINE_SOURCE =~ /^(web|api)$/ && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CHANT_SCHEDULED_OP == "chant-apply-failed-agent"' },
    ]);
    expect(failed.yaml).not.toContain("trigger token");
    expect(() => gen({ name: "x", agent: { on: "schedule", task: "t" } })).toThrow(/cron trigger/);
  });

  test("every command line carries the settings' digest, so a pipeline variable cannot widen the agent", () => {
    for (const { doc } of [failed, sched]) {
      const lines = Object.values(doc).flatMap((j) => j?.script ?? []).filter((l) => typeof l === "string" && l.includes("chant agent "));
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const l of lines) expect(l).toMatch(/--digest sha256:[0-9a-f]{64}/);
    }
    const script = failed.doc["chant-apply-failed-agent"]!.script;
    expect(script.findIndex((l) => l.includes("set-head origin"))).toBeLessThan(script.findIndex((l) => l.includes("git remote set-url origin")));
  });

  test("a scheduled agent holds no relay key; neither applies, approves or merges", () => {
    expect(sched.yaml).not.toContain("CHANT_RELAY_KEY");
    for (const { doc } of [failed, sched]) {
      const all = Object.values(doc).flatMap((j) => j?.script ?? []).join("\n");
      expect(all).not.toMatch(/chant (run|approve)\b|merge_when_pipeline_succeeds|\bterraform apply\b|\bpulumi up\b/);
    }
  });
});

// #5339: the failed-verify agent, in its schedule or a pipeline of the default branch started by hand.
describe("the failed-verify agent on GitLab", () => {
  const v = gen({ name: "chant-verify-failed-agent", agent: { on: "verify-failed" } });

  test("runs in its schedule or a pipeline of the default branch started by hand, with the relay key off the model's step", () => {
    expect(v.doc["chant-verify-failed-agent"]!.rules).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "schedule" && $CHANT_SCHEDULED_OP == "chant-verify-failed-agent"' },
      { if: '$CI_PIPELINE_SOURCE =~ /^(web|api)$/ && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CHANT_SCHEDULED_OP == "chant-verify-failed-agent"' },
    ]);
    expect(v.yaml).toContain("answers the failed verifies and soaks recorded under _alerts/");
    const script = v.doc["chant-verify-failed-agent"]!.script;
    expect(script.findIndex((l) => l.startsWith("unset CHANT_RELAY_KEY"))).toBeLessThan(script.findIndex((l) => l.includes("chant agent run")));
    expect(() => gen({ name: "x", trigger: { kind: "push" } as never, agent: { on: "verify-failed" } })).toThrow(/failed-verify agent/);
  });

  test("every command line carries the settings' digest; it never applies, approves, merges or rolls back", () => {
    const lines = Object.values(v.doc).flatMap((j) => j?.script ?? []).filter((l) => typeof l === "string" && l.includes("chant agent "));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(l).toMatch(/--digest sha256:[0-9a-f]{64}/);
    const all = Object.values(v.doc).flatMap((j) => j?.script ?? []).join("\n");
    expect(all).not.toMatch(/chant (run|approve)\b|components (promote|rollback)|merge_when_pipeline_succeeds|\bterraform apply\b|\bpulumi up\b/);
  });
});
