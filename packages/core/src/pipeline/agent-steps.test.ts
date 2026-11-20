/**
 * #5358: an agent step in a stage, with an answer of a declared shape that
 * later steps, the gate's policy and the risk record read. It never
 * approves, never applies and holds a read token only.
 */

import { describe, expect, test } from "vitest";
import { memoryGateLedgerPort } from "../op/gate";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import { agentStepRiskReasons, scoreChangeRisk } from "../change-risk";
import { stageRiskRead } from "../lifecycle/release-risk";
import { asPipelineSpec, pipelineSpecProblems, type PipelineSpec, type PipelineStage } from "./spec";
import { pipelinePromoteAgentSteps, pipelinePromoteGates } from "./promote";
import type { StageArtifactPort, StageArtifactRecord } from "./artifacts";
import { overLimit } from "../ci-agent";
import { quoted } from "../op/activities/review-agent";
import {
  agentStepRiskLevels,
  agentStepSchemaDigest,
  checkedAgentAnswer,
  readStageAgentAnswers,
  runStageAgentSteps,
  stageAgentPolicyInput,
  STAGE_AGENT_ANSWER_KIND,
  STAGE_AGENT_STEPS_FLOOR,
  type AgentStepModel,
  type PipelineAgentStep,
  type StageAgentAnswerPort,
  type StageAgentAnswerRecord,
} from "./agent-steps";

const RELEASE = "sha256:" + "1".repeat(64);
const now = new Date("2026-11-20T01:00:00.000Z");
const wave = (target: string) => [{ name: target, runs: [{ target }] }];

const WATCH: PipelineAgentStep = {
  prompt: "List the services to watch during the soak.",
  reads: { endpoint: { stage: "dev", artifact: "endpoint" }, db: { stage: "dev", artifact: "db_password" } },
  schema: { type: "object", required: ["services", "risk"], additionalProperties: false, properties: { services: { type: "array", items: { type: "string" } }, risk: { enum: ["low", "medium", "high"] } } },
};
const NOTES: PipelineAgentStep = { prompt: "Write the release notes' summary.", reads: { watch: { step: "watch" } }, schema: { type: "string", maxLength: 200 } };

function specWith(staging: Partial<PipelineStage> = {}): PipelineSpec {
  return asPipelineSpec({
    name: "shop",
    stages: [
      { name: "dev", waves: wave("dev"), gate: { policy: "never" }, publish: { endpoint: { member: "cluster", output: "endpoint" }, db_password: { secret: { awsSecretsManager: "arn:aws:secretsmanager:us-east-2:111111111111:secret:dev/db" } } } },
      { name: "staging", waves: wave("staging"), agentSteps: { watch: WATCH, notes: NOTES }, ...staging },
    ],
  });
}

function artifactPort(): StageArtifactPort {
  const record: StageArtifactRecord = {
    version: 1,
    kind: "stage-artifacts",
    pipeline: "shop",
    stage: "dev",
    release: RELEASE,
    label: "v1.4.0",
    at: "2026-11-20T00:00:00.000Z",
    artifacts: {
      endpoint: { kind: "value", value: "https://dev.example.internal", member: "cluster", output: "endpoint" },
      db_password: { kind: "secret", source: { store: "aws-secrets-manager", id: "arn:aws:secretsmanager:us-east-2:111111111111:secret:dev/db" } },
    },
  };
  return { read: async (stage) => (stage === "dev" ? [record] : []), append: async () => { throw new Error("the agent step writes no artifact"); } };
}

function answerPort(seed: StageAgentAnswerRecord[] = []): StageAgentAnswerPort & { lines: StageAgentAnswerRecord[] } {
  const lines = [...seed];
  return { lines, read: async () => lines, append: async (_s, r) => void lines.push(r) };
}

/** A model that answers each step from a table, and remembers each prompt. */
function model(answers: Record<string, string>, seen: string[] = []): AgentStepModel {
  return async ({ settings, prompt }) => {
    seen.push(prompt);
    const step = settings.name.split("-").pop()!;
    return { stdout: JSON.stringify({ type: "result", result: answers[step] ?? "", total_cost_usd: 0.12 }), exitCode: 0, usage: { usd: 0.12, model: "claude-test" } };
  };
}

async function run(spec: PipelineSpec, answers: Record<string, string>, over: Partial<Parameters<typeof runStageAgentSteps>[0]> = {}, seen: string[] = []) {
  return runStageAgentSteps({
    spec,
    stage: "staging",
    release: { digest: RELEASE, label: "v1.4.0", gitSha: "c".repeat(40) },
    defaultCommand: "model",
    model: model(answers, seen),
    artifacts: artifactPort(),
    readRuns: async () => [],
    hasKey: () => true,
    quote: quoted,
    overLimit,
    digestOf: (t) => `sha256:${t.length}`,
    now: () => now,
    ...over,
  });
}

const GOOD = { watch: JSON.stringify({ services: ["checkout", "orders"], risk: "high" }), notes: '"Adds the orders index."' };

describe("the declaration", () => {
  test("a stage declares an agent step with a prompt, what it reads and a JSON schema; the spec folds", () => {
    expect(pipelineSpecProblems(specWith())).toEqual([]);
    expect(STAGE_AGENT_STEPS_FLOOR).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the first stage takes none: it applies before the merge cuts the release a step answers for", () => {
    const problems = pipelineSpecProblems({ name: "shop", stages: [{ name: "dev", waves: wave("dev"), agentSteps: { notes: { prompt: "x", schema: { type: "string" } } } }] });
    expect(problems.join("\n")).toContain('stage "dev" declares agent steps');
  });

  test("a schema that does not compile, a read nobody publishes, and a read of a later step are refused", () => {
    const problems = pipelineSpecProblems({
      name: "shop",
      stages: [
        { name: "dev", waves: wave("dev") },
        {
          name: "staging",
          waves: wave("staging"),
          agentSteps: {
            a: { prompt: "x", schema: { type: "nonsense" } },
            b: { prompt: "x", schema: { type: "string" }, reads: { e: { stage: "dev", artifact: "endpoint" }, c: { step: "c" } } },
            c: { prompt: "x", schema: { type: "string" } },
          },
        },
      ],
    }).join("\n");
    expect(problems).toContain("agentSteps.a.schema does not compile");
    expect(problems).toContain('which that stage never publishes');
    expect(problems).toContain('reads step "c", which is not declared before "b"');
  });

  test("a gate whose policy reads the answers cannot be never", () => {
    const problems = pipelineSpecProblems({ ...specWith(), stages: [specWith().stages[0], { ...specWith().stages[1], gate: { policy: "never", holds: { policy: true } } }] }).join("\n");
    expect(problems).toContain("a gate whose policy reads an agent's answer waits for a person's approval");
  });
});

describe("running a stage's steps", () => {
  test("each step answers in order; a later step reads an earlier answer; a secret reads as where it is kept", async () => {
    const seen: string[] = [];
    const records = await run(specWith(), GOOD, {}, seen);
    expect(records.map((r) => [r.step, r.status])).toEqual([["watch", "answered"], ["notes", "answered"]]);
    expect(records[0]!.answer).toEqual({ services: ["checkout", "orders"], risk: "high" });
    expect(records[0]).toMatchObject({ release: RELEASE, label: "v1.4.0", schemaDigest: agentStepSchemaDigest(WATCH.schema), usage: { usd: 0.12 } });
    expect(records[0]!.promptDigest).toMatch(/^sha256:/);
    expect(records[0]!.reads).toContainEqual({ name: "db", stage: "dev", artifact: "db_password", secret: true });
    expect(seen[0]).toContain("https://dev.example.internal");
    expect(seen[0]).toContain('\\"store\\":\\"aws-secrets-manager\\"');
    expect(seen[1]).toContain("checkout");
  });

  test("an answer that does not match the schema fails the step, says why, and fails the step that reads it", async () => {
    const records = await run(specWith(), { ...GOOD, watch: JSON.stringify({ services: "checkout", risk: "high" }) });
    expect(records[0]).toMatchObject({ status: "failed" });
    expect(records[0]!.reason).toContain("the answer does not match the step's schema: /services must be array");
    expect(records[0]!.answer).toBeUndefined();
    expect(records[1]!.reason).toContain('reads step "watch", which failed');
  });

  test("an answer that is not JSON fails the step", async () => {
    const [r] = await run(specWith(), { ...GOOD, watch: "Watch checkout." });
    expect(r!.reason).toMatch(/^the answer is not JSON/);
  });

  test("a step past its cap does not run the model, and says so", async () => {
    const capped = specWith({ agentSteps: { watch: { ...WATCH, maxRuns: 1 } } });
    const seen: string[] = [];
    const [r] = await run(capped, GOOD, { readRuns: async () => [{ started: "2026-11-20T00:30:00.000Z" }] }, seen);
    expect(r).toMatchObject({ status: "failed" });
    expect(r!.reason).toContain('agent step "watch"');
    expect(seen).toEqual([]);
  });

  test("the run holds a read token only: it reads the ledger and writes nothing to it", async () => {
    // The artifact port throws on any write; the run hands its records back for the record step.
    const records = await run(specWith(), GOOD);
    expect(records).toHaveLength(2);
    const noKey = await run(specWith(), GOOD, { hasKey: () => false });
    expect(noKey[0]!.reason).toContain("the job has no ANTHROPIC_API_KEY variable");
  });
});

describe("recording, and the promote's hold", () => {
  test("the record step checks each answer against the schema at base again", async () => {
    const [watch] = await run(specWith(), GOOD);
    expect(checkedAgentAnswer(specWith(), "staging", RELEASE, watch)).toMatchObject({ status: "answered" });
    const forged = { ...watch!, answer: { services: 3 } };
    expect(checkedAgentAnswer(specWith(), "staging", RELEASE, forged)).toMatchObject({ status: "failed", reason: expect.stringContaining("does not match") });
    expect(checkedAgentAnswer(specWith(), "staging", "sha256:" + "2".repeat(64), watch)).toEqual({ refused: expect.stringContaining("not sha256:2") });
  });

  test("a stage with a failed step holds (exit 3), and the run says why", async () => {
    const records = await run(specWith(), { ...GOOD, notes: "42" });
    const out = await pipelinePromoteAgentSteps({ spec: specWith(), to: "staging", release: { digest: RELEASE, label: "v1.4.0" }, port: answerPort(records) });
    expect(out).toMatchObject({ passed: false, exitCode: 3, code: "pipeline-agent-step-holding" });
    if (!out.passed) expect(out.message).toContain('agent step "notes" failed for release v1.4.0: the answer does not match the step\'s schema: / must be string');
  });

  test("a stage holds while a step has no answer, and refuses a promote that names no release", async () => {
    const held = await pipelinePromoteAgentSteps({ spec: specWith(), to: "staging", release: { digest: RELEASE }, port: answerPort() });
    expect(held).toMatchObject({ passed: false, exitCode: 3 });
    const none = await pipelinePromoteAgentSteps({ spec: specWith(), to: "staging", port: answerPort() });
    expect(none).toMatchObject({ passed: false, exitCode: 1, code: "pipeline-agent-step-no-release" });
  });

  test("answered: the policy reads input.agent.<step>, a deny refuses, and the risk record gets a reason per level", async () => {
    const port = answerPort(await run(specWith(), GOOD));
    const answers = await readStageAgentAnswers(port, { stage: "staging", release: RELEASE });
    const input = stageAgentPolicyInput(answers);
    expect(input.watch).toMatchObject({ answer: { services: ["checkout", "orders"], risk: "high" }, release: RELEASE, costUsd: 0.12, schemaDigest: agentStepSchemaDigest(WATCH.schema) });
    expect(input.watch!.promptDigest).toMatch(/^sha256:/);

    const asked: unknown[] = [];
    const gated = specWith({ gate: { holds: { policy: true } } });
    const passed = await pipelinePromoteAgentSteps({ spec: gated, to: "staging", release: { digest: RELEASE }, port, policy: async (agent) => (asked.push(agent), { result: "passed", reasons: [] }) });
    expect(asked[0]).toEqual(input);
    expect(passed).toMatchObject({ passed: true, risk: [{ id: "agent.watch", value: 1, weight: 0.5 }] });
    if (passed.passed) expect(passed.lines.at(-1)).toContain("the gate still waits for a person's approval");

    const denied = await pipelinePromoteAgentSteps({ spec: gated, to: "staging", release: { digest: RELEASE }, port, policy: async () => ({ result: "denied", reasons: ["orders is on the watch list"] }) });
    expect(denied).toMatchObject({ passed: false, exitCode: 1, code: "pipeline-agent-policy-denied" });
  });

  test("nothing turns on by default: a stage with no agent steps reads no answer and runs no policy", async () => {
    let asked = false;
    const plain = asPipelineSpec({ name: "shop", stages: [{ name: "dev", waves: wave("dev") }, { name: "staging", waves: wave("staging"), gate: { holds: { policy: true } } }] });
    const out = await pipelinePromoteAgentSteps({ spec: plain, to: "staging", port: { read: async () => { throw new Error("read"); }, append: async () => {} }, policy: async () => ((asked = true), undefined) });
    expect(out).toEqual({ passed: true, lines: [], agent: {}, risk: [] });
    expect(asked).toBe(false);
  });
});

describe("the generated jobs", () => {
  test("a stage with agent steps hands its model keys to the promote generator; a stage with none hands nothing", async () => {
    const { generatePipeline } = await import("./generate");
    let seen: import("../lexicon").PipelinePromoteInput | undefined;
    const plugin = {
      generateOpWavesPipeline: () => ({ files: [], jobs: [] }),
      generatePipelinePromote: (i: import("../lexicon").PipelinePromoteInput) => ((seen = i), []),
    } as unknown as import("../lexicon").LexiconPlugin;
    const spec = asPipelineSpec({ ...specWith(), defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" } }, stages: [specWith().stages[0], { ...specWith().stages[1], agentSteps: { watch: WATCH, notes: { ...NOTES, keyEnv: "NOTES_KEY" } } }, { name: "prod", waves: wave("prod") }] });
    const got = await generatePipeline(spec, "github", {}, plugin);
    expect(got.error).toBeUndefined();
    expect(seen!.stages.map((s) => s.agentSteps)).toEqual([{ keyEnvs: ["ANTHROPIC_API_KEY", "NOTES_KEY"] }, undefined]);
  });
});

describe("the gate whose policy reads the answer", () => {
  const approval = (resolvedBy: string, kind: "human" | "agent"): GateResolutionRecord => ({
    version: 1,
    op: "shop",
    gate: "staging",
    resolvedBy,
    timestamp: "2026-11-20T00:40:00.000Z",
    planDigest: RELEASE,
    environment: "staging",
    approver: { kind },
  });
  const gated = specWith({ gate: { holds: { policy: true } } });

  test("the agent principal's approval is refused by name, and the gate waits for a person", async () => {
    const out = await pipelinePromoteGates({ spec: gated, to: "staging", skipped: [], digest: RELEASE, releaseDigest: RELEASE, port: memoryGateLedgerPort({ resolutions: [approval("release-bot", "agent")] }), now });
    expect(out).toMatchObject({ passed: false, exitCode: 3, code: "pipeline-gate-waiting" });
    expect(out.lines?.join("\n")).toContain("release-bot is an agent, and a gate whose policy reads an agent step's answer counts a person's approval only");
  });

  test("a person's approval passes it", async () => {
    const out = await pipelinePromoteGates({ spec: gated, to: "staging", skipped: [], digest: RELEASE, releaseDigest: RELEASE, port: memoryGateLedgerPort({ resolutions: [approval("release-bot", "agent"), approval("alice", "human")] }), now });
    expect(out).toMatchObject({ passed: true, lines: ["stage staging: shop staging approved by alice"] });
  });

  test("a spec written around the build's refusal of never still waits for a person", async () => {
    const around = { ...gated, stages: [gated.stages[0]!, { ...gated.stages[1]!, gate: { policy: "never" as const, holds: { policy: true } } }] };
    const out = await pipelinePromoteGates({ spec: around, to: "staging", skipped: [], digest: RELEASE, releaseDigest: RELEASE, port: memoryGateLedgerPort(), now });
    expect(out).toMatchObject({ passed: false, exitCode: 3 });
  });
});

describe("the risk record reads the answer as a reason", () => {
  test("an answer's level is one reason, weighed as the review's level is; an answer with none adds nothing", () => {
    const answers: Record<string, StageAgentAnswerRecord> = {
      watch: { version: 1, kind: STAGE_AGENT_ANSWER_KIND, pipeline: "shop", stage: "staging", step: "watch", release: RELEASE, at: "t", status: "answered", answer: { risk: "high" }, schemaDigest: "d" },
      notes: { version: 1, kind: STAGE_AGENT_ANSWER_KIND, pipeline: "shop", stage: "staging", step: "notes", release: RELEASE, at: "t", status: "answered", answer: "text", schemaDigest: "d" },
    };
    expect(agentStepRiskLevels(answers)).toEqual({ watch: "high" });
    const risk = scoreChangeRisk({ changeSet: { members: [], entries: [] }, review: { risk: "high" }, agent: { watch: "high" } });
    const review = risk.reasons.find((r) => r.id === "review")!;
    const agent = risk.reasons.find((r) => r.id === "agent.watch")!;
    expect(agent).toMatchObject({ weight: review.weight, value: review.value, contribution: review.contribution, detail: "agent step watch answered high" });
    expect(scoreChangeRisk({ changeSet: { members: [], entries: [] } }).reasons.some((r) => r.id.startsWith("agent."))).toBe(false);
  });

  test("at the stage gate the reason raises the release's score over the threshold, and only raises it", () => {
    const spec = asPipelineSpec({
      name: "shop",
      defaults: { holds: { risk: { approveAbove: 0.4 } } },
      stages: [{ name: "dev", waves: wave("dev") }, { name: "staging", waves: wave("staging"), agentSteps: { watch: { prompt: "x", schema: { type: "object" } } } }],
    });
    const record = { version: 1 as const, commit: "c".repeat(40), score: 0.2, level: "low" as const, waves: [] };
    const without = stageRiskRead(spec, "staging", record)!;
    expect(without.risk).toMatchObject({ score: 0.2, over: false });
    const withAgent = stageRiskRead(spec, "staging", record, agentStepRiskReasons({ watch: "high" }))!;
    expect(withAgent.risk).toMatchObject({ score: 0.6, over: true });
    expect(withAgent.risk!.reasons.map((r) => r.id)).toContain("agent.watch");
    const low = stageRiskRead(spec, "staging", record, agentStepRiskReasons({ watch: "low" }))!;
    expect(low.risk!.score).toBe(0.2);
  });
});
