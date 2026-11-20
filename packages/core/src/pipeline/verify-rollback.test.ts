/**
 * A rollback a stage requests when its verify or soak fails (#5328).
 */
import { describe, expect, test } from "vitest";
import { memoryGateLedgerPort } from "../op/gate";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import type { DriverComponentResult } from "../components/driver";
import { planReleaseRollback } from "../components/promote";
import {
  asPipelineSpec,
  memberStateOf,
  memberStatesOf,
  memoryStageLedgerPort,
  parseStagePauseLines,
  pipelineFromConfig,
  pipelineSpecProblems,
  requestedRollbackGate,
  requestStageRollback,
  rolledBackLine,
  stageFailures,
  stageOnVerifyFail,
  standingRollbackRequest,
  verifyRollbackProblems,
  VERIFY_ROLLBACK_FLOOR,
  type PipelineSpec,
  type RollbackCapabilityView,
  type StageRollbackInput,
} from "../pipeline";
import { NEXT_RELEASE } from "../release-floors";
import { NOTIFY_EVENTS, type NotifyEvent } from "../notify";
import { PRODUCT_CONFIG_WORDS } from "../ci-product-words";

const wave = (name: string) => ({ name, runs: [{ target: name }] });
const spec: PipelineSpec = asPipelineSpec({
  name: "shop",
  stages: [
    { name: "dev", waves: [wave("dev")], gate: { policy: "never" } },
    { name: "staging", waves: [wave("staging")], gate: { policy: "never" }, onVerifyFail: "rollback" },
    { name: "prod", waves: [wave("prod")], gate: { quorum: [{ count: 2 }] }, onVerifyFail: "rollback" },
  ],
});
const at = (m: number) => new Date(Date.UTC(2026, 10, 20, 0, m));
const v1 = { digest: "sha256:" + "1".repeat(64), label: "v1" };
const v2 = { digest: "sha256:" + "2".repeat(64), label: "v2" };

function record(component: string, env: string, release: { digest: string }, minute: number, over: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    version: 1,
    component,
    env,
    digest: `sha256:${component}-${release.digest.slice(7, 9)}`,
    gitSha: "a".repeat(40),
    runId: `run-${minute}`,
    timestamp: at(minute).toISOString(),
    actor: "ci",
    releaseDigest: release.digest,
    ...over,
  } as ReleaseRecord;
}

const ok = (component: string): DriverComponentResult => ({ component, ok: true, status: "ok", records: [{ component, phase: "deploy", kind: "terraform-apply", status: "ok", durationMs: 1 }] });
const fail = (component: string, records: DriverComponentResult["records"]): DriverComponentResult => ({ component, ok: false, status: "fail", records });

describe("onVerifyFail on a stage", () => {
  test("the default is hold, and an unknown value is refused", () => {
    const plain = asPipelineSpec({ name: "shop", stages: [{ name: "dev", waves: [wave("dev")] }] });
    expect(stageOnVerifyFail(plain.stages[0])).toBe("hold");
    expect(stageOnVerifyFail(spec.stages[1])).toBe("rollback");
    expect(pipelineSpecProblems({ name: "shop", stages: [{ name: "dev", waves: [wave("dev")], onVerifyFail: "revert" }] })).toEqual(['stage "dev".onVerifyFail is hold or rollback']);
  });

  test("a product maps on_verify_fail, and writes nothing for hold", () => {
    const declaration = pipelineFromConfig({
      name: "shop",
      promotion: ["dev", "prod"],
      environments: { dev: { on_verify_fail: "hold" }, prod: { on_verify_fail: "rollback" } },
      waves: { dev: [wave("dev")], prod: [wave("prod")] },
    });
    expect(declaration.stages[0]!.onVerifyFail).toBeUndefined();
    expect(declaration.stages[1]!.onVerifyFail).toBe("rollback");
    expect(() => pipelineFromConfig({ name: "shop", promotion: ["dev"], environments: { dev: { on_verify_fail: "undo" as never } }, waves: { dev: [wave("dev")] } })).toThrow(/onVerifyFail is hold or rollback/);
  });

  test("the key is in the vocabulary, and the floor names the next release", () => {
    expect(PRODUCT_CONFIG_WORDS.find((w) => w.key === "environments.<name>.on_verify_fail")).toMatchObject({ section: "stage", values: ["hold", "rollback"] });
    expect(VERIFY_ROLLBACK_FLOOR).toBe(NEXT_RELEASE);
    expect(NOTIFY_EVENTS).toContain("rollback-requested");
  });
});

describe("each member's state after a run", () => {
  test("applied, left applied, rolled back and not applied", () => {
    expect(memberStateOf(ok("api"))).toBe("applied");
    // terraform-apply declares no rollback, so the step's noRollback leaves its change in place.
    expect(memberStateOf(fail("net", [
      { component: "net", phase: "deploy", kind: "terraform-apply", status: "ok", durationMs: 1 },
      { component: "net", phase: "verify", kind: "http-check", status: "fail", durationMs: 1, error: "503" },
      { component: "net", phase: "deploy", kind: "terraform-apply", status: "rollback-opted-out", durationMs: 0, error: "state is the record" },
    ]))).toBe("left-applied");
    expect(memberStateOf(fail("web", [
      { component: "web", phase: "deploy", kind: "kubectl-apply", status: "ok", durationMs: 1 },
      { component: "web", phase: "verify", kind: "http-check", status: "fail", durationMs: 1 },
      { component: "web", phase: "deploy", kind: "kubectl-apply", status: "rolled-back", durationMs: 1 },
    ]))).toBe("rolled-back");
    expect(memberStateOf(fail("db", [
      { component: "db", phase: "deploy", kind: "x", status: "ok", durationMs: 1 },
      { component: "db", phase: "verify", kind: "http-check", status: "fail", durationMs: 1 },
      { component: "db", phase: "deploy", kind: "x", status: "fail", durationMs: 1, error: "undo failed" },
    ]))).toBe("left-applied");
    expect(memberStateOf(fail("q", [{ component: "q", phase: "deploy", kind: "x", status: "fail", durationMs: 1 }]))).toBe("not-applied");
    expect(memberStateOf(undefined)).toBe("not-applied");
  });
});

/** A stage's input with the ledgers in memory: prod ran v1, then v2 failed its verify. */
function input(over: Partial<StageRollbackInput> = {}): StageRollbackInput & { sent: NotifyEvent[]; stagesPort: ReturnType<typeof memoryStageLedgerPort>; gatesPort: ReturnType<typeof memoryGateLedgerPort> } {
  const sent: NotifyEvent[] = [];
  const stagesPort = memoryStageLedgerPort();
  const gatesPort = memoryGateLedgerPort();
  return {
    spec,
    stage: "prod",
    failure: "verify",
    failed: v2,
    members: [
      { member: "api", state: "applied" },
      { member: "net", state: "left-applied" },
      { member: "web", state: "rolled-back" },
      { member: "queue", state: "not-applied" },
    ],
    detail: ["net verify/http-check: 503"],
    records: [record("api", "prod", v1, 1), record("net", "prod", v1, 1), record("web", "prod", v1, 1), record("queue", "prod", v1, 1), record("api", "prod", v2, 10)],
    exclude: new Set([v2.digest]),
    check: async () => ({ kept: true, revoked: null }),
    label: (d) => (d === v1.digest ? "v1" : d === v2.digest ? "v2" : null),
    stages: stagesPort,
    gates: gatesPort,
    by: "ci",
    now: at(11),
    notify: { config: undefined, source: "chant", send: async (_c, e) => sent.push(e) },
    sent,
    stagesPort,
    gatesPort,
    ...over,
  };
}

describe("a failed verify requests the rollback", () => {
  test("a stage that holds writes nothing", async () => {
    const i = input({ stage: "dev" });
    expect(await requestStageRollback(i)).toEqual({ status: "hold" });
    expect(i.stagesPort.lines).toEqual([]);
    expect(i.sent).toEqual([]);
  });

  test("it writes the failure, a request bound to the previous release, the gate's pending fact and a notice, and exits 3", async () => {
    const i = input();
    const out = await requestStageRollback(i);
    expect(out).toMatchObject({ status: "requested", exitCode: 3, hint: expect.stringContaining("chant components rollback prod --requested") });
    const [failed, request] = i.stagesPort.lines;
    expect(failed).toMatchObject({ kind: "failed", failure: "verify", failed: v2, detail: ["net verify/http-check: 503"] });
    expect(request).toMatchObject({ kind: "rollback-requested", failureId: failed!.id, release: v1, failed: v2, gate: "prod-rollback" });
    // Mixed holds: the members left applied are requested; the others say why they are not.
    expect(request!.members).toEqual([
      { member: "api", state: "applied", rollback: "requested" },
      { member: "net", state: "left-applied", rollback: "requested" },
      { member: "web", state: "rolled-back", rollback: "its own steps were undone when it failed" },
      { member: "queue", state: "not-applied", rollback: "nothing of it applied" },
    ]);
    expect(out.status === "requested" && out.lines).toEqual(expect.arrayContaining(["api: applied, rolled back by the request", "web: rolled-back, not rolled back: its own steps were undone when it failed"]));
    expect(i.gatesPort.appended).toHaveLength(1);
    expect(i.gatesPort.appended[0]).toMatchObject({ op: "shop", gate: "prod-rollback", planDigest: v1.digest, releaseDigest: v1.digest, environment: "prod" });
    expect(i.sent).toHaveLength(1);
    expect(i.sent[0]).toMatchObject({ schema: "chant.notify/v1", event: "rollback-requested", environment: "prod", digest: v1.digest, targets: ["api", "net"], rollback: { stage: "prod", failure: "verify", failed: v2, to: v1, gate: "prod-rollback" } });
    // The lines read back from the file.
    const text = i.stagesPort.lines.map((l) => JSON.stringify(l)).join("\n");
    expect(parseStagePauseLines(text).lines).toHaveLength(2);
  });

  test("a request that stands is not written again, and the failure fact stays readable on its own", async () => {
    const i = input();
    await requestStageRollback(i);
    const again = await requestStageRollback({ ...i, now: at(20) });
    expect(again).toMatchObject({ status: "standing", exitCode: 3 });
    expect(i.stagesPort.lines.map((l) => l.kind)).toEqual(["failed", "rollback-requested"]);
    expect(i.sent).toHaveLength(1);
    // Another reader of failures (an agent trigger) reads the failed line without the request.
    expect(stageFailures(i.stagesPort.lines)).toEqual([i.stagesPort.lines[0]]);
  });

  test("a stage with no earlier release holds and says so", async () => {
    const i = input({ records: [record("api", "prod", v2, 10)] });
    const out = await requestStageRollback(i);
    expect(out).toMatchObject({ status: "held", reason: "stage prod ran no earlier release, so there is nothing to roll back to" });
    expect(i.stagesPort.lines.map((l) => l.kind)).toEqual(["failed", "rollback-held"]);
    expect(i.stagesPort.lines[1]).toMatchObject({ failureId: i.stagesPort.lines[0]!.id, held: expect.stringContaining("no earlier release") });
    expect(i.gatesPort.appended).toEqual([]);
    expect(i.sent).toEqual([]);
  });

  test("a stage whose earlier release is revoked holds and names it", async () => {
    const i = input({ check: async () => ({ kept: true, revoked: "phase e2e failed" }) });
    expect(await requestStageRollback(i)).toMatchObject({ status: "held", reason: "stage prod's earlier release v1 is revoked (phase e2e failed), so it is not restored" });
    const gone = input({ check: async () => ({ kept: false, revoked: null }) });
    expect(await requestStageRollback(gone)).toMatchObject({ status: "held", reason: expect.stringContaining("v1 is no longer kept") });
  });

  test("a soak failure requests the same way, keyed on the release that soaks", async () => {
    const i = input({ failure: "soak", members: [{ member: "api", state: "applied" }], detail: ["check errors failed"], stage: "staging", records: [record("api", "staging", v1, 1), record("api", "staging", v2, 5)] });
    const out = await requestStageRollback(i);
    expect(out).toMatchObject({ status: "requested" });
    expect(i.stagesPort.lines[0]).toMatchObject({ kind: "failed", failure: "soak", stage: "staging" });
    expect(i.sent[0]!.rollback).toMatchObject({ failure: "soak", to: v1 });
  });
});

describe("the requested rollback's gate", () => {
  const approval = (who: string, minute: number, over: Partial<GateResolutionRecord> = {}): GateResolutionRecord =>
    ({ version: 1, op: "shop", gate: "staging-rollback", resolvedBy: who, timestamp: at(minute).toISOString(), planDigest: v1.digest, releaseDigest: v1.digest, environment: "staging", approver: { kind: "human" }, ...over }) as GateResolutionRecord;

  async function requested(stage = "staging") {
    const i = input({ stage, records: [record("api", stage, v1, 1), record("api", stage, v2, 10)], members: [{ member: "api", state: "applied" }] });
    await requestStageRollback(i);
    return { request: standingRollbackRequest(i.stagesPort.lines)!, pending: i.gatesPort.appended };
  }

  test("it waits for a person even when the stage's gate policy is never", async () => {
    const { request, pending } = await requested();
    const port = memoryGateLedgerPort({ pending });
    expect(await requestedRollbackGate({ spec, stage: "staging", request, port, now: at(12) })).toMatchObject({ passed: false, exitCode: 3, code: "pipeline-rollback-waiting", hint: expect.stringContaining("chant approve shop staging-rollback --env staging") });
  });

  test("an approval since the request passes it; one from before, or one already spent, does not", async () => {
    const { request, pending } = await requested();
    const passes = await requestedRollbackGate({ spec, stage: "staging", request, port: memoryGateLedgerPort({ pending, resolutions: [approval("github:ana", 12)] }), now: at(13) });
    expect(passes).toMatchObject({ passed: true, approval: { resolvedBy: "github:ana" } });
    const before = await requestedRollbackGate({ spec, stage: "staging", request, port: memoryGateLedgerPort({ pending, resolutions: [approval("github:ana", 5)] }), now: at(13) });
    expect(before).toMatchObject({ passed: false });
    const spent = memoryGateLedgerPort({ pending, resolutions: [approval("github:ana", 12)], applied: [{ version: 1, kind: "applied", op: "shop", gate: "staging-rollback", planDigest: v1.digest, approvedAt: at(12).toISOString(), approvedBy: "github:ana", timestamp: at(12).toISOString() }] });
    expect(await requestedRollbackGate({ spec, stage: "staging", request, port: spent, now: at(13) })).toMatchObject({ passed: false });
    const otherRelease = await requestedRollbackGate({ spec, stage: "staging", request, port: memoryGateLedgerPort({ pending, resolutions: [approval("github:ana", 12, { planDigest: v2.digest, releaseDigest: v2.digest })] }), now: at(13) });
    expect(otherRelease).toMatchObject({ passed: false });
  });

  test("it takes the stage gate's approval rules", async () => {
    const { request, pending } = await requested("prod");
    const one = memoryGateLedgerPort({ pending, resolutions: [approval("github:ana", 12, { gate: "prod-rollback", environment: "prod" })] });
    expect(await requestedRollbackGate({ spec, stage: "prod", request, port: one, now: at(13) })).toMatchObject({ passed: false });
    const two = memoryGateLedgerPort({ pending, resolutions: [approval("github:ana", 12, { gate: "prod-rollback", environment: "prod" }), approval("github:bo", 12, { gate: "prod-rollback", environment: "prod" })] });
    expect(await requestedRollbackGate({ spec, stage: "prod", request, port: two, now: at(13) })).toMatchObject({ passed: true });
  });

  test("the rolled-back line links the rollback to its request and its failure, and answers the request", async () => {
    const i = input({ stage: "staging", records: [record("api", "staging", v1, 1)], members: [{ member: "api", state: "applied" }] });
    await requestStageRollback(i);
    const request = standingRollbackRequest(i.stagesPort.lines)!;
    const done = rolledBackLine({ request, by: "github:ana", approval: approval("github:bo", 12), now: at(14) });
    expect(done).toMatchObject({ kind: "rolled-back", requestId: request.id, failureId: request.failureId, release: v1, members: [{ member: "api", state: "applied", rollback: "requested" }], approval: { by: "github:bo" } });
    expect(standingRollbackRequest([...i.stagesPort.lines, done])).toBeUndefined();
  });
});

describe("the rollback restores only the members the request names", () => {
  test("planReleaseRollback with only leaves the other components of the release alone", () => {
    const records = [record("api", "prod", v1, 1), record("web", "prod", v1, 1), record("api", "prod", v2, 10)];
    const release = { releaseDigest: v1.digest, artifactDigests: [{ component: "api", digest: "x" }, { component: "web", digest: "y" }], targets: [] } as never;
    const plan = planReleaseRollback({ env: "prod", records, declared: ["api", "web"], release, label: "v1", only: new Set(["api"]) });
    expect("items" in plan && plan.items.map((i) => i.component)).toEqual(["api"]);
  });
});

describe("the build refuses rollback on steps an earlier release does not restore", () => {
  const caps: Record<string, RollbackCapabilityView> = {
    "terraform-apply": { releaseInputs: true, rollbackPolicy: "needs-opt-out" },
    "pulumi-up": { releaseInputs: true, rollbackPolicy: "needs-opt-out" },
    "kubectl-apply": { releaseInputs: false, rollbackPolicy: "needs-opt-out" },
    "http-check": { releaseInputs: false, rollbackPolicy: "none-by-design" },
    "sql-migrate": { releaseInputs: false, rollbackPolicy: "needs-opt-out" },
  };
  const capability = (kind: string) => caps[kind];
  const one = asPipelineSpec({ name: "shop", stages: [{ name: "dev", waves: [wave("dev")] }, { name: "prod", waves: [wave("prod")], onVerifyFail: "rollback" }] });

  test("terraform-apply and pulumi-up pass, as do steps that change nothing; noRollback decides nothing", () => {
    expect(verifyRollbackProblems({ spec: one, capability, steps: [{ where: 'component "net" step deploy/terraform-apply', kind: "terraform-apply" }, { where: 'component "app" step deploy/pulumi-up', kind: "pulumi-up" }, { where: 'component "app" step verify/http-check', kind: "http-check" }] })).toEqual([]);
  });

  test("a sql-migrate step, a step without releaseInputs and an unknown kind are refused, naming the step and why", () => {
    const problems = verifyRollbackProblems({ spec: one, capability, steps: [{ where: "defaults.step", kind: "sql-migrate" }, { where: 'component "web" step deploy/kubectl-apply', kind: "kubectl-apply" }, { where: 'component "x" step deploy/mystery', kind: "mystery" }] });
    expect(problems).toEqual([
      'stage "prod" sets onVerifyFail: "rollback", and defaults.step cannot be rolled back that way: it runs migrations, and applying an earlier release does not take back a migration that ran; set onVerifyFail to "hold" on it',
      'stage "prod" sets onVerifyFail: "rollback", and component "web" step deploy/kubectl-apply cannot be rolled back that way: its kind "kubectl-apply" answers no releaseInputs, so a release records none of its files and components rollback --release has nothing of it to apply; set onVerifyFail to "hold" on it',
      'stage "prod" sets onVerifyFail: "rollback", and component "x" step deploy/mystery cannot be rolled back that way: no capability of kind "mystery" is registered, so nothing says whether an earlier release restores it; set onVerifyFail to "hold" on it',
    ]);
  });

  test("a pipeline with every stage on hold reads no step", () => {
    const hold = asPipelineSpec({ name: "shop", stages: [{ name: "dev", waves: [wave("dev")] }] });
    expect(verifyRollbackProblems({ spec: hold, capability: () => undefined, steps: [{ where: "defaults.step", kind: "sql-migrate" }] })).toEqual([]);
  });
});
