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

// #4619: on Forgejo too, a member's drift Op hands its own output on, and the agent job takes it at the root.
describe("the drift agent of a workspace member on Forgejo", () => {
  const out = generateForgejoOpPipeline([{ name: "drift-app", trigger: { kind: "cron", schedule: "0 6 * * *" }, agent: { on: "drift" } }], { member: { name: "app", dir: "stacks/app" } });
  const d = parseYAML(out.files[0]!.yaml) as unknown as { jobs: Record<string, { defaults?: { run?: { "working-directory"?: string } }; steps: Array<{ name?: string; run?: string }> }> };

  test("the drift check runs in the member's directory, and the agent job reads what it handed on", () => {
    expect(d.jobs["drift-app"]!.defaults?.run?.["working-directory"]).toBe("stacks/app");
    const agent = d.jobs["drift-app-agent"]!;
    expect(agent.defaults).toBeUndefined();
    expect(agent.steps.find((s) => s.name === "Take the drift from the drift check")!.run).toContain(" .chant/agent <<");
    expect(agent.steps.some((s) => s.run?.includes("chant agent prepare --forge forgejo --output .chant/agent"))).toBe(true);
  });
});

// #5329: the alert agent on Forgejo, started by the relay's workflow_dispatch and by its schedule.
describe("the alert agent on Forgejo", () => {
  const out = generateForgejoOpPipeline([{ name: "chant-alert-agent", agent: { on: "alert" } }]);
  const d = parseYAML(out.files[0]!.yaml) as unknown as { on: Record<string, unknown>; jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string> }> }> };

  test("runs on workflow_dispatch and its schedule, and lands with the relay key", () => {
    expect(Object.keys(d.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    const land = d.jobs["chant-alert-agent-push"]!.steps.at(-1)!;
    expect(land.run).toContain("chant agent land --forge forgejo");
    expect(land.env?.CHANT_RELAY_KEY).toBeDefined();
  });
});

// #5357: the failed-apply and scheduled agents on Forgejo.
describe("the failed-apply and scheduled agents on Forgejo", () => {
  test("run on workflow_dispatch and their schedule, with the settings' digest on the land line", () => {
    for (const spec of [
      { name: "chant-apply-failed-agent", agent: { on: "apply-failed" as const } },
      { name: "chant-versions", trigger: { kind: "cron" as const, schedule: "0 7 * * 1" }, agent: { on: "schedule" as const, task: "Raise the pins." } },
    ]) {
      const out = generateForgejoOpPipeline([spec]);
      const d = parseYAML(out.files[0]!.yaml) as unknown as { on: Record<string, unknown>; jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string> }> }> };
      expect(Object.keys(d.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
      const land = d.jobs[`${spec.name}-push`]!.steps.at(-1)!;
      expect(land.run).toMatch(/chant agent land --forge forgejo --output \.chant\/agent --digest sha256:[0-9a-f]{64}/);
      expect(land.env?.CHANT_RELAY_KEY === undefined).toBe(spec.agent.on === "schedule");
    }
  });
});

// #5339: the failed-verify agent on Forgejo.
describe("the failed-verify agent on Forgejo", () => {
  test("runs on workflow_dispatch and its schedule, and lands with the relay key and the settings' digest", () => {
    const out = generateForgejoOpPipeline([{ name: "chant-verify-failed-agent", agent: { on: "verify-failed" } }]);
    const d = parseYAML(out.files[0]!.yaml) as unknown as { on: Record<string, unknown>; jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string> }> }> };
    expect(Object.keys(d.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    const land = d.jobs["chant-verify-failed-agent-push"]!.steps.at(-1)!;
    expect(land.run).toMatch(/chant agent land --forge forgejo --output \.chant\/agent --digest sha256:[0-9a-f]{64}/);
    expect(land.env?.CHANT_RELAY_KEY).toBeDefined();
    const all = Object.values(d.jobs).flatMap((j) => j.steps.map((s) => s.run ?? "")).join("\n");
    expect(all).not.toMatch(/chant (run|approve)\b|components (promote|rollback)|--admin|\bterraform apply\b|\bpulumi up\b/);
  });
});

// terragucci#1528: Forgejo publishes a job's outputs only when it succeeds.
describe("the drift job on Forgejo publishes its outputs (terragucci#1528)", () => {
  const spec: ScheduledOpSpec = { name: "drift-app", trigger: { kind: "cron", schedule: "0 6 * * *" }, runner: "agents", agent: { on: "drift" } };
  const d = parseYAML(generateForgejoOpPipeline([spec]).files[0]!.yaml) as unknown as { jobs: Record<string, { needs?: string; if?: string; "runs-on"?: unknown; steps: Array<{ id?: string; run?: string }> }> };

  test("the drift job exits 0 on drift with drift=true written", () => {
    const run = d.jobs["drift-app"]!.steps.find((s) => s.id === "chant-run")!.run!;
    expect(run).toContain('echo "drift=true"');
    expect(run).toContain('if [ "$code" -eq 2 ]; then exit 0; fi');
  });

  test("the found job needs the drift job, runs on drift, and exits with the drift code", () => {
    const found = d.jobs["drift-app-found"]!;
    expect(found.needs).toBe("drift-app");
    expect(found.if).toBe("needs.drift-app.outputs.drift == 'true'");
    expect(found["runs-on"]).toBe("agents");
    expect(found.steps.at(-1)!.run).toMatch(/exit 2$/);
  });

  test("an update's job has a found job too, and an Op with neither has none", () => {
    const u = parseYAML(generateForgejoOpPipeline([{ name: "drift-app", trigger: { kind: "cron", schedule: "0 6 * * *" }, update: { command: "x" } }]).files[0]!.yaml) as unknown as { jobs: Record<string, unknown> };
    expect(u.jobs["drift-app-found"]).toBeDefined();
    const n = parseYAML(generateForgejoOpPipeline([{ name: "drift-app", trigger: { kind: "cron", schedule: "0 6 * * *" } }]).files[0]!.yaml) as unknown as { jobs: Record<string, unknown> };
    expect(n.jobs["drift-app-found"]).toBeUndefined();
  });
});
