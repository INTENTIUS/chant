/**
 * Pausing a stage, the pause after a rollback, and the urgent rule (#5355).
 */
import { describe, expect, test } from "vitest";
import { memoryGateLedgerPort } from "../op/gate";
import type { GateQuorumJudge } from "../op/gate-quorum";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import type { GateRejectionRecord } from "../lifecycle/gate-rejection";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import type { DeployOutcome } from "../lifecycle/deploy-outcome";
import {
  asPipelineSpec,
  memoryStageLedgerPort,
  parseStagePauseLines,
  pauseLine,
  pipelineFromConfig,
  pipelinePromoteSource,
  pipelineSpecProblems,
  pipelineUrgentGate,
  pipelinePromoteGates,
  pipelineUrgentUpstream,
  pipelineStageEntry,
  memoryStageLogPort,
  urgentUpstreamStages,
  releaseMissingIn,
  resumeLine,
  stagePaused,
  stagePausedLine,
  STAGE_PAUSE_URGENT_FLOOR,
  supersededBy,
  urgentGateName,
  urgentUpstreamStop,
  waitingLine,
  waitingReleases,
  type PipelineSpec,
  type StagePauseLine,
} from "../pipeline";
import { stageCommand } from "../cli/handlers/stage";
import { NEXT_RELEASE } from "../release-floors";
import { makeNotifyEvent, NOTIFY_EVENTS } from "../notify";
import { PRODUCT_CONFIG_WORDS, PRODUCT_RELEASE_WORDS } from "../ci-product-words";

const wave = (name: string) => ({ name, runs: [{ target: name }] });
const spec: PipelineSpec = asPipelineSpec({
  name: "shop",
  defaults: { op: "shop" },
  stages: [
    { name: "dev", waves: [wave("dev")], gate: { policy: "never" } },
    { name: "staging", waves: [wave("staging")], pauseAfterRollback: true },
    { name: "prod", waves: [wave("prod")], gate: { approval: "sealed", quorum: [{ count: 2, roles: ["sre"] }], urgent: { role: "sre-lead" } } },
  ],
});
const at = (m: number) => new Date(Date.UTC(2026, 10, 20, 0, m));
const r1 = { digest: "sha256:" + "1".repeat(64), label: "v1" };
const r2 = { digest: "sha256:" + "2".repeat(64), label: "v2" };
const r3 = { digest: "sha256:" + "3".repeat(64), label: "v3" };

describe("the spec takes the urgent rule and the pause after a rollback", () => {
  test("both read, and a bad shape is refused", () => {
    expect(pipelineSpecProblems(spec)).toEqual([]);
    const bad = { ...spec, stages: [{ ...spec.stages[0]!, pauseAfterRollback: "yes", gate: { urgent: { role: "" , who: 1 } } }] };
    expect(pipelineSpecProblems(bad)).toEqual([
      'stage "dev".pauseAfterRollback must be true or false',
      'stage "dev".gate.urgent has an unknown key "who"; it takes role',
      'stage "dev".gate.urgent.role must name a role in .chant/trust.json',
    ]);
  });

  test("nothing turns on unless the stage sets it", () => {
    const plain = asPipelineSpec({ name: "shop", stages: [{ name: "dev", waves: [wave("dev")] }, { name: "prod", waves: [wave("prod")] }] });
    expect(plain.stages[1]!.gate?.urgent).toBeUndefined();
    expect(plain.stages[1]!.pauseAfterRollback).toBeUndefined();
    expect(pipelinePromoteSource({ spec: plain, to: "prod", urgent: true, now: at(0) })).toMatchObject({ exitCode: 1, code: "pipeline-no-urgent-rule" });
  });

  test("a product maps urgent.role and pause_after_rollback from its config", () => {
    const declaration = pipelineFromConfig({
      name: "shop",
      promotion: ["dev", "prod"],
      environments: { prod: { urgent: { role: "sre-lead" }, pause_after_rollback: true } },
      waves: { dev: [wave("dev")], prod: [wave("prod")] },
    });
    expect(declaration.stages[1]).toMatchObject({ gate: { urgent: { role: "sre-lead" } }, pauseAfterRollback: true });
    expect(declaration.stages[0]!.pauseAfterRollback).toBeUndefined();
  });

  test("the keys and command words are in the vocabulary", () => {
    const keys = PRODUCT_CONFIG_WORDS.map((w) => w.key);
    expect(keys).toContain("environments.<name>.urgent.role");
    expect(keys).toContain("environments.<name>.pause_after_rollback");
    expect(PRODUCT_RELEASE_WORDS).toMatchObject({ pause: "pause", resume: "resume", urgent: "--urgent", reason: "--reason" });
  });
});

describe("pause and resume", () => {
  test("pause and resume are recorded with who and why", async () => {
    const port = memoryStageLedgerPort();
    const paused = await stageCommand({ verb: "pause", spec, stage: "prod", by: "github:alice", reason: "incident 42", port, now: at(1) });
    expect(paused.exitCode).toBe(0);
    expect(port.lines).toEqual([{ version: 1, kind: "pause", pipeline: "shop", stage: "prod", by: "github:alice", reason: "incident 42", timestamp: at(1).toISOString() }]);
    expect(stagePaused(port.lines)).toBe(port.lines[0]);
    expect((await stageCommand({ verb: "pause", spec, stage: "prod", by: "github:bob", port, now: at(2) })).exitCode).toBe(1);

    const resumed = await stageCommand({ verb: "resume", spec, stage: "prod", by: "github:bob", reason: "fixed", port, now: at(3) });
    expect(resumed.exitCode).toBe(0);
    expect(port.lines[1]).toMatchObject({ kind: "resume", by: "github:bob", reason: "fixed" });
    expect(stagePaused(port.lines)).toBeUndefined();
    expect((await stageCommand({ verb: "resume", spec, stage: "prod", by: "github:bob", port, now: at(4) })).exitCode).toBe(1);
    expect((await stageCommand({ verb: "pause", spec, stage: "qa", by: "github:bob", port, now: at(4) })).exitCode).toBe(1);
  });

  test("on resume the newest waiting release enters, and the older ones are refused", async () => {
    const port = memoryStageLedgerPort();
    await stageCommand({ verb: "pause", spec, stage: "prod", by: "github:alice", port, now: at(1) });
    for (const [i, r] of [r1, r2, r1, r3].entries()) await port.append(waitingLine({ pipeline: "shop", stage: "prod", by: "ci", release: r, now: at(2 + i) }));
    expect(waitingReleases(port.lines).map((r) => r.label)).toEqual(["v2", "v1", "v3"]);
    const resumed = await stageCommand({ verb: "resume", spec, stage: "prod", by: "github:alice", port, now: at(9) });
    expect(resumed.lines.map((l) => l.text).join("\n")).toContain("release v3 is the newest that waited, and it enters");
    const resume = port.lines.at(-1)!;
    expect(resume).toMatchObject({ kind: "resume", admits: r3, superseded: [r2.digest, r1.digest] });
    expect(supersededBy(port.lines, r1.digest)).toBe(resume);
    expect(supersededBy(port.lines, r3.digest)).toBeUndefined();
    // A release that never waited is not refused.
    expect(supersededBy(port.lines, "sha256:" + "9".repeat(64))).toBeUndefined();
  });

  test("a waiting line from before the pause does not enter", () => {
    const lines: StagePauseLine[] = [];
    const push = (l: StagePauseLine | { refused: string }) => {
      if ("refused" in l) throw new Error(l.refused);
      lines.push(l);
    };
    push(pauseLine({ pipeline: "shop", stage: "prod", by: "a", lines, now: at(1) }));
    lines.push(waitingLine({ pipeline: "shop", stage: "prod", by: "ci", release: r1, now: at(2) }));
    push(resumeLine({ pipeline: "shop", stage: "prod", by: "a", lines, now: at(3) }));
    push(pauseLine({ pipeline: "shop", stage: "prod", by: "a", lines, now: at(4) }));
    expect(waitingReleases(lines)).toEqual([]);
    expect(resumeLine({ pipeline: "shop", stage: "prod", by: "a", lines, now: at(5) })).not.toHaveProperty("admits");
  });

  test("the ledger's text reads back, and a line that does not read is counted", () => {
    const line = waitingLine({ pipeline: "shop", stage: "prod", by: "ci", release: r1, now: at(1) });
    expect(parseStagePauseLines(`${JSON.stringify(line)}\nnot json\n{"version":2}\n`)).toEqual({ lines: [line], malformed: 2 });
  });
});

describe("the pause after a rollback", () => {
  test("a rollback's pause names the release and says it came from the rollback", () => {
    const pause = pauseLine({ pipeline: "shop", stage: "staging", by: "github:alice", lines: [], now: at(1), cause: "rollback", release: r1 });
    expect(pause).toMatchObject({ kind: "pause", cause: "rollback", release: r1 });
    expect(stagePausedLine(pause as StagePauseLine)).toBe(`stage "staging" is paused since ${at(1).toISOString()} by github:alice (after a rollback to v1), so nothing is promoted into it`);
  });

  test("a stage paused already stays paused, with one pause line", () => {
    const first = pauseLine({ pipeline: "shop", stage: "staging", by: "a", lines: [], now: at(1) }) as StagePauseLine;
    expect(pauseLine({ pipeline: "shop", stage: "staging", by: "a", lines: [first], now: at(2), cause: "rollback" })).toHaveProperty("refused");
  });
});

describe("the urgent rule", () => {
  const digest = r3.digest;
  const judgeOf = (proven: Record<string, string[]>): GateQuorumJudge => (r) => ({ proven: r.resolvedBy in proven, roles: proven[r.resolvedBy] ?? [] });
  const line = (who: string, extra: Partial<GateResolutionRecord> = {}): GateResolutionRecord =>
    ({ version: 1, op: "shop", gate: urgentGateName("prod"), resolvedBy: who, timestamp: "2026-11-20T00:00:30Z", planDigest: digest, environment: "prod", approver: { kind: "human" }, ...extra }) as GateResolutionRecord;

  test("it skips no stage, with or without --allow-skip", () => {
    expect(pipelinePromoteSource({ spec, to: "prod", from: "dev", urgent: true, now: at(0) })).toMatchObject({ exitCode: 1, code: "pipeline-urgent-skips" });
    expect(pipelinePromoteSource({ spec, to: "prod", from: "dev", urgent: true, allowSkip: true, now: at(0) })).toMatchObject({ exitCode: 1, code: "pipeline-urgent-skips", message: expect.stringContaining("skips staging") });
    expect(pipelinePromoteSource({ spec, to: "prod", urgent: true, now: at(0) })).toEqual({ from: "staging", skipped: [] });
  });

  test("a hold still refuses it", () => {
    const held = asPipelineSpec({ ...spec, stages: spec.stages.map((s) => (s.name === "prod" ? { ...s, hold: true as const } : s)) });
    expect(pipelinePromoteSource({ spec: held, to: "prod", urgent: true, now: at(0) })).toMatchObject({ exitCode: 3, code: "pipeline-stage-held" });
  });

  // Every approval mode the stage's gate can name: the urgent rule counts a proven approver from its role only.
  for (const approval of ["ledger", "pr-review", "sealed", "pull-request"] as const) {
    test(`under ${approval}, one proven approval from the role passes, and a plain line or another role does not`, async () => {
      const s = asPipelineSpec({ ...spec, stages: spec.stages.map((st) => (st.name === "prod" ? { ...st, gate: { ...st.gate, approval } } : st)) });
      const nobody = memoryGateLedgerPort();
      const waits = await pipelineUrgentGate({ spec: s, to: "prod", digest, port: { ...nobody, quorumJudge: async () => judgeOf({}) }, now: at(1) });
      expect(waits).toMatchObject({ passed: false, exitCode: 3, code: "pipeline-gate-waiting", hint: expect.stringContaining("--sign") });
      expect(nobody.appended[0]).toMatchObject({ op: "shop", gate: "prod-urgent", planDigest: digest, environment: "prod" });

      // A plain line from someone who holds the role in name only: not proven.
      const plain = memoryGateLedgerPort({ resolutions: [line("github:carol")] });
      expect((await pipelineUrgentGate({ spec: s, to: "prod", digest, port: { ...plain, quorumJudge: async () => judgeOf({}) }, now: at(1) })).passed).toBe(false);
      // A proven approver from another role.
      const other = memoryGateLedgerPort({ resolutions: [line("github:dave")] });
      expect((await pipelineUrgentGate({ spec: s, to: "prod", digest, port: { ...other, quorumJudge: async () => judgeOf({ "github:dave": ["sre"] }) }, now: at(1) })).passed).toBe(false);
      // An approval of another release.
      const elsewhere = memoryGateLedgerPort({ resolutions: [line("github:erin", { planDigest: r2.digest })] });
      expect((await pipelineUrgentGate({ spec: s, to: "prod", digest, port: { ...elsewhere, quorumJudge: async () => judgeOf({ "github:erin": ["sre-lead"] }) }, now: at(1) })).passed).toBe(false);

      const approved = memoryGateLedgerPort({ resolutions: [line("github:erin", { note: "payments down" })] });
      const passed = await pipelineUrgentGate({ spec: s, to: "prod", digest, port: { ...approved, quorumJudge: async () => judgeOf({ "github:erin": ["sre-lead"] }) }, now: at(1) });
      expect(passed).toMatchObject({ passed: true, role: "sre-lead", approval: { resolvedBy: "github:erin", note: "payments down" } });
      expect(approved.applied).toEqual([expect.objectContaining({ op: "shop", gate: "prod-urgent", planDigest: digest, approvedBy: "github:erin" })]);
    });
  }

  test("a rejection of the release stops an urgent promote before its approval is read, at the stage's gate or its urgent gate (#5354)", async () => {
    const plain = asPipelineSpec({ ...spec, stages: spec.stages.map((st) => (st.name === "prod" ? { ...st, gate: { urgent: { role: "sre-lead" } } } : st)) });
    const rejection = (gate: string): GateRejectionRecord => ({
      version: 1,
      kind: "rejection",
      op: "shop",
      gate,
      rejectedBy: "alice",
      reason: "the fix drops a column the reports read",
      timestamp: "2026-11-20T00:00:20Z",
      planDigest: digest,
      environment: "prod",
      releaseDigest: digest,
      approver: { kind: "human" },
    });
    for (const gate of ["prod", "prod-urgent"]) {
      const port = { ...memoryGateLedgerPort({ resolutions: [line("github:erin")], rejections: [rejection(gate)] }), quorumJudge: async () => judgeOf({ "github:erin": ["sre-lead"] }) };
      const out = await pipelinePromoteGates({ spec: plain, to: "prod", skipped: [], digest, releaseDigest: digest, port, urgent: true, now: at(1) });
      expect(out).toMatchObject({ passed: false, exitCode: 8, code: "pipeline-release-rejected", message: expect.stringContaining(`shop ${gate}`) });
      // The proven urgent approval is never read, so nothing is spent.
      expect(port.applied).toEqual([]);
    }
    // A rejection of another release does not stop this one.
    const other = { ...memoryGateLedgerPort({ resolutions: [line("github:erin")], rejections: [{ ...rejection("prod"), planDigest: r2.digest, releaseDigest: r2.digest }] }), quorumJudge: async () => judgeOf({ "github:erin": ["sre-lead"] }) };
    await expect(pipelinePromoteGates({ spec: plain, to: "prod", skipped: [], digest, releaseDigest: digest, port: other, urgent: true, now: at(1) })).resolves.toMatchObject({ passed: true, urgent: { role: "sre-lead" } });
  });

  test("with no judge, no approval proves anyone, so nothing passes", async () => {
    const port = memoryGateLedgerPort({ resolutions: [line("github:erin")] });
    expect((await pipelineUrgentGate({ spec, to: "prod", digest, port, now: at(1) })).passed).toBe(false);
  });

  test("the release must have succeeded in every earlier stage", async () => {
    const rec = (env: string, component: string, extra: Partial<ReleaseRecord> = {}): ReleaseRecord =>
      ({ component, env, digest: "sha256:a", gitSha: "c".repeat(40), timestamp: "2026-11-20T00:00:00Z", actor: "ci", releaseDigest: digest, ...extra }) as ReleaseRecord;
    const failed: DeployOutcome = { version: 1, env: "staging", verb: "promote", runId: "r", timestamp: "2026-11-20T00:05:00Z", actor: "ci", releaseDigest: digest, status: "fail", components: [{ component: "api", outcome: "failed", digest: "sha256:a", releaseDigest: digest }] } as DeployOutcome;
    const ledgers: Record<string, { records: ReleaseRecord[]; outcomes: DeployOutcome[] }> = {
      dev: { records: [rec("dev", "api", { releaseDigest: undefined }), rec("dev", "web", { releaseDigest: undefined })], outcomes: [] },
      staging: { records: [rec("staging", "api"), rec("staging", "web")], outcomes: [failed] },
    };
    const missingIn = async (stage: string) => releaseMissingIn({ ...ledgers[stage]!, releaseDigest: digest, commit: "c".repeat(40), components: ["api", "web"] });
    const missing = await pipelineUrgentUpstream({ spec, to: "prod", missingIn });
    expect(missing).toEqual([{ stage: "staging", missing: ["api"] }]);
    expect(urgentUpstreamStop("v3", missing)).toMatchObject({ exitCode: 1, code: "pipeline-urgent-upstream", message: expect.stringContaining("staging (api)") });

    ledgers.staging!.outcomes = [];
    expect(await pipelineUrgentUpstream({ spec, to: "prod", missingIn })).toEqual([]);
    ledgers.dev!.records = [rec("dev", "api", { releaseDigest: undefined, gitSha: "d".repeat(40) })];
    expect(await pipelineUrgentUpstream({ spec, to: "prod", missingIn })).toEqual([{ stage: "dev", missing: ["api", "web"] }]);
  });

  describe("through a join (#5353)", () => {
    // dev fans out to eu and us; prod joins them. qa follows us in the list with no after, so it is no upstream of prod.
    const graph: PipelineSpec = asPipelineSpec({
      name: "shop",
      stages: [
        { name: "dev", waves: [wave("dev")], gate: { policy: "never" } },
        { name: "eu", waves: [wave("eu")] },
        { name: "us", waves: [wave("us")], after: ["dev"] },
        { name: "qa", waves: [wave("qa")] },
        { name: "prod", waves: [wave("prod")], after: ["eu", "us"], gate: { urgent: { role: "sre-lead" } } },
      ],
    });

    test("a stage with after checks the stages it names and theirs; one without checks every earlier stage", () => {
      expect(urgentUpstreamStages(graph, "prod")).toEqual(["dev", "eu", "us"]);
      expect(urgentUpstreamStages(graph, "qa")).toEqual(["dev", "eu", "us"]);
      expect(urgentUpstreamStages(graph, "us")).toEqual(["dev"]);
      expect(urgentUpstreamStages(spec, "prod")).toEqual(["dev", "staging"]);
      expect(urgentUpstreamStages(graph, "dev")).toEqual([]);
    });

    test("an urgent release follows the join once it succeeded in each upstream, whatever qa holds", async () => {
      const ran: string[] = [];
      const missingIn = (done: string[]) => async (stage: string) => {
        ran.push(stage);
        return done.includes(stage) ? [] : ["api"];
      };
      expect(await pipelineUrgentUpstream({ spec: graph, to: "prod", missingIn: missingIn(["dev", "eu", "us"]) })).toEqual([]);
      expect(ran).toEqual(["dev", "eu", "us"]);
      expect(await pipelineUrgentUpstream({ spec: graph, to: "prod", missingIn: missingIn(["dev", "eu"]) })).toEqual([{ stage: "us", missing: ["api"] }]);
      expect(pipelinePromoteSource({ spec: graph, to: "prod", urgent: true, now: at(0) })).toEqual({ from: "eu", skipped: [], upstreams: ["eu", "us"] });
    });

    test("the join's entry passes on the urgent rule, writes its entered line and carries the approval", async () => {
      const finished = (stage: string) => ({ version: 1 as const, kind: "finished" as const, op: "shop", stage, digest, timestamp: "2026-11-20T00:00:10Z", result: "applied" as const });
      const log = memoryStageLogPort([finished("eu"), finished("us")]);
      const release = { releaseDigest: digest, label: "v3", commit: "c".repeat(40) };
      const port = { ...memoryGateLedgerPort({ resolutions: [line("github:erin")] }), quorumJudge: async () => judgeOf({ "github:erin": ["sre-lead"] }) };
      const out = await pipelineStageEntry({ spec: graph, to: "prod", skipped: [], upstreams: ["eu", "us"], digest, release, port, log, urgent: true, now: at(1) });
      expect(out).toMatchObject({ passed: true, urgent: { role: "sre-lead", approval: { resolvedBy: "github:erin" } }, entered: { kind: "entered", stage: "prod" } });
      expect(port.applied).toEqual([expect.objectContaining({ gate: "prod-urgent", approvedBy: "github:erin" })]);

      // With us still missing, --allow-skip would take us through its skip gate; the urgent path refuses that.
      const partial = memoryStageLogPort([finished("eu")]);
      const skip = await pipelineStageEntry({ spec: graph, to: "prod", skipped: [], upstreams: ["eu", "us"], allowSkip: true, digest, release, port, log: partial, urgent: true, now: at(1) });
      expect(skip).toMatchObject({ passed: false, exitCode: 1, code: "pipeline-urgent-skips" });
    });
  });

  test("each use sends a chant.notify/v1 event of its own kind", () => {
    expect(NOTIFY_EVENTS).toContain("urgent");
    const e = makeNotifyEvent({ source: "chant", event: "urgent", summary: "release v3 promoted into prod on its urgent rule", environment: "prod", digest }, { env: {}, now: at(1) });
    expect(e).toMatchObject({ schema: "chant.notify/v1", event: "urgent", environment: "prod", digest });
  });
});

test("the floor names the next release", () => {
  expect(STAGE_PAUSE_URGENT_FLOOR).toBe(NEXT_RELEASE);
});
