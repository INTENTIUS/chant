/**
 * The after-plan hook's wave answer (#4842): what a product adds to the wave
 * as a whole once it read every run's plan. Pending fact fields, digest
 * members that are no run, holds, overriders, and the gate report chant
 * stores beside the pending fact.
 */

import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpWavesSpec } from "./op-waves";
import { runOpWave, opWaveSetDigest, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort, opWaveGateReportPath } from "./gate";
import { CapabilityRegistry, type Capability } from "../components/capability";
import type { ChangeSetPart } from "../change-set";
import { opWaveAfterPlanWaveResultProblems, opWaveAfterPlanResultProblems, type OpWaveAfterPlanWave } from "./op-waves-after-plan";

const digest = (n: string) => `sha256:${n.repeat(64)}`;
const NOW = "2026-11-08T00:00:00.000Z";

const part = (member: string): ChangeSetPart => ({
  member: { member, lexicon: "terraform", planner: "chant", status: "planned", planDigest: digest("9"), holes: [] },
  entries: [{ member, address: `aws_s3_bucket.${member}`, type: "aws_s3_bucket", action: "create" } as ChangeSetPart["entries"][number]],
});

function capability(digests: Record<string, string>): { registry: CapabilityRegistry; ran: string[] } {
  const ran: string[] = [];
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-apply",
    async plan(_ctx, input) {
      const root = String(input.root);
      return { member: root, planDigest: digests[root]!, artifact: { planFile: `${root}.tfplan` }, changeSet: part(root) };
    },
    async run(_ctx, input) {
      ran.push(String(input.root));
      return {};
    },
  };
  return { registry: new CapabilityRegistry().register(cap), ran };
}

const base = (gate: "never" | "always"): OpWavesSpec => ({
  name: "tf-apply",
  op: "tf-apply",
  gateName: "wave-{k}",
  step: { kind: "fake-apply", root: "{target}" },
  waves: [{ name: "wave-1", runs: [{ target: "network" }, { target: "app" }], gate }],
});

const digests = { network: digest("1"), app: digest("2") };

function harness(spec: OpWavesSpec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-wave-answer-"));
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
  return { cwd, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe("the after-plan hook's wave answer (#4842)", () => {
  test("pending fields, digest members and holds: the wave waits whatever its gate, and its digest covers the members", async () => {
    const spec = base("never");
    const h = harness(spec);
    const { registry, ran } = capability(digests);
    const gates = memoryGateLedgerPort();
    const seen: OpWaveAfterPlanWave[] = [];
    const cost = { member: "(monthly cost)", planDigest: digest("7") };
    const result = await runOpWave({
      spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates, capabilities: registry, now: NOW, log: () => {},
      afterPlan: {
        name: "terragucci",
        run: () => {},
        wave: (w) => {
          seen.push(w);
          return { pending: { description: "wave 1 of 1: network, app", commit: "c".repeat(40) }, members: [cost], holds: ["app reads network's vpc_id, unknown when the change was reviewed"] };
        },
      },
    });
    expect(seen.map((w) => [w.wave, w.job, w.runs.map((r) => r.target)])).toEqual([[1, "wave", ["network", "app"]]]);
    expect(result.exitCode).toBe(3);
    expect(ran).toEqual([]);
    expect(result.decision?.heldBy).toEqual(["app reads network's vpc_id, unknown when the change was reviewed"]);
    expect(result.decision?.extras).toEqual([cost]);
    const members = [{ member: "network", planDigest: digests.network }, { member: "app", planDigest: digests.app }];
    expect(result.decision?.digest).toBe(opWaveSetDigest(spec, members, [cost]));
    expect(gates.appended[0]).toMatchObject({ op: "tf-apply", gate: "wave-1", description: "wave 1 of 1: network, app", commit: "c".repeat(40) });
    h.done();
  });

  test("the report is stored beside the pending fact it asks approval for, once", async () => {
    const spec = base("always");
    const h = harness(spec);
    const { registry } = capability(digests);
    const gates = memoryGateLedgerPort();
    const go = (report: string) =>
      runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates, capabilities: registry, now: NOW, log: () => {}, afterPlan: { name: "terragucci", run: () => {}, wave: () => ({ report }) } });
    const first = await go('{"roots":["network","app"]}');
    expect(first.exitCode).toBe(3);
    const at = opWaveGateReportPath("tf-apply", "wave-1", first.decision!.digest);
    expect(at).toBe(`_gates/tf-apply/wave-1/${first.decision!.digest.replace(":", "_")}.json`);
    expect(gates.reports.get(at)).toBe('{"roots":["network","app"]}');
    const again = await go('{"roots":["changed"]}');
    expect(again.decision!.digest).toBe(first.decision!.digest);
    expect(gates.reports.get(at)).toBe('{"roots":["network","app"]}');
    h.done();
  });

  test("a wave that needs no approval stores no report", async () => {
    const spec = base("never");
    const h = harness(spec);
    const { registry, ran } = capability(digests);
    const gates = memoryGateLedgerPort();
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates, capabilities: registry, now: NOW, log: () => {}, afterPlan: { name: "terragucci", run: () => {}, wave: () => ({ report: "{}" }) } });
    expect(result.exitCode).toBe(0);
    expect(ran).toEqual(["network", "app"]);
    expect(gates.reports.size).toBe(0);
    h.done();
  });

  test("after an approval of other plans, the report of the plans now and of the plans approved are written for the respond job", async () => {
    const spec = base("always");
    const h = harness(spec);
    const { registry } = capability(digests);
    const was = digest("9");
    const gates = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: "2026-11-07T00:00:00Z", planDigest: was }] });
    gates.reports.set(opWaveGateReportPath("tf-apply", "wave-1", was), '{"roots":["network"]}');
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates, capabilities: registry, now: NOW, log: () => {}, afterPlan: { name: "terragucci", run: () => {}, wave: () => ({ report: '{"roots":["network","app"]}' }) } });
    expect(result.exitCode).toBe(3);
    expect(result.decision?.mismatch).toMatchObject({ approved: was, resolvedBy: "alice" });
    expect(result.decision?.reports).toEqual({ current: ".chant/op-waves/tf-apply/wave-1/report/current.json", approved: ".chant/op-waves/tf-apply/wave-1/report/approved.json" });
    expect(readFileSync(join(h.cwd, result.decision!.reports!.current), "utf-8")).toBe('{"roots":["network","app"]}');
    expect(readFileSync(join(h.cwd, result.decision!.reports!.approved!), "utf-8")).toBe('{"roots":["network"]}');
    h.done();
  });

  test("with no report kept for the plans approved, only the report of the plans now is written", async () => {
    const spec = base("always");
    const h = harness(spec);
    const { registry } = capability(digests);
    const gates = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: "2026-11-07T00:00:00Z", planDigest: digest("9") }] });
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates, capabilities: registry, now: NOW, log: () => {}, afterPlan: { name: "terragucci", run: () => {}, wave: () => ({ report: "{}" }) } });
    expect(result.decision?.reports).toEqual({ current: ".chant/op-waves/tf-apply/wave-1/report/current.json" });
    expect(existsSync(join(h.cwd, ".chant/op-waves/tf-apply/wave-1/report/approved.json"))).toBe(false);
    h.done();
  });

  test("the wave answer's overriders replace the list at base, and a run's own overriders replace them for that run", async () => {
    const { overrideDigest } = await import("../override-gate");
    const spec = base("never");
    const od = overrideDigest("app", digests.app, ["no-public-s3"]);
    const override = { version: 1 as const, op: "policy-override", gate: "app", resolvedBy: "github:carol", timestamp: "2026-11-07T00:00:00Z", planDigest: od, note: "the bucket is the public docs site" };
    const deny = (target: string) => ({ policy: target === "app" ? [{ source: "terragucci", result: "denied" as const, rules: ["no-public-s3"] }] : [] });
    // The wave's list names someone else: carol's override does not count.
    const h = harness(spec);
    const { registry, ran } = capability(digests);
    const refused = await runOpWave({
      spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort({ resolutions: [override] }), capabilities: registry, now: NOW, log: () => {},
      afterPlan: { name: "terragucci", run: (r) => deny(r.target), wave: () => ({ overriders: ["github:dave"], overridersSource: "policy.override in terragucci.yml" }) },
    });
    expect(refused.exitCode).toBe(7);
    expect(refused.decision?.refused).toMatchObject({ runs: ["app"], overridersSource: "policy.override in terragucci.yml" });
    expect(ran).toEqual([]);
    // app's own list names carol: her override lets it through.
    const gates = memoryGateLedgerPort({ resolutions: [override] });
    const passed = await runOpWave({
      spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates, capabilities: registry, now: NOW, log: () => {},
      afterPlan: { name: "terragucci", run: (r) => ({ ...deny(r.target), ...(r.target === "app" ? { overriders: ["github:carol"] } : {}) }), wave: () => ({ overriders: ["github:dave"] }) },
    });
    expect(passed.exitCode).toBe(0);
    expect(passed.decision?.members.find((m) => m.member === "app")).toMatchObject({ override: { by: "github:carol", digest: od } });
    expect(ran).toEqual(["network", "app"]);
    h.done();
  });

  test("a wave answer that throws fails the wave before the gate under fail, and holds it under approve", async () => {
    const spec = base("never");
    const h = harness(spec);
    const { registry, ran } = capability(digests);
    const failed = await runOpWave({
      spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry, now: NOW, log: () => {},
      afterPlan: { name: "terragucci", run: () => {}, wave: () => { throw new Error("the estimator did not run"); } },
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.decision).toBeUndefined();
    expect(failed.hooks.filter((o) => o.moment === "after-plan").map((o) => [o.target ?? "(wave)", o.outcome])).toEqual([["network", "passed"], ["app", "passed"], ["(wave)", "failed"]]);
    const held = await runOpWave({
      spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry, now: NOW, log: () => {},
      afterPlan: { name: "terragucci", onFailure: "approve", run: () => {}, wave: () => { throw new Error("the estimator did not run"); } },
    });
    expect(held.exitCode).toBe(3);
    expect(held.decision?.heldBy).toEqual(["after-plan hook terragucci (wave 1)"]);
    expect(ran).toEqual([]);
    h.done();
  });

  test("a hook with no wave answer leaves the wave as it was", async () => {
    const spec = base("never");
    const h = harness(spec);
    const { registry } = capability(digests);
    const gates = memoryGateLedgerPort();
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates, capabilities: registry, now: NOW, log: () => {}, afterPlan: { name: "terragucci", run: () => {} } });
    expect(result.exitCode).toBe(0);
    expect(result.decision?.extras).toBeUndefined();
    expect(result.decision?.reports).toBeUndefined();
    h.done();
  });

  test("the answers are checked", () => {
    expect(opWaveAfterPlanWaveResultProblems({ pending: { op: "x" }, overriders: [1], members: [{ member: "network", planDigest: digest("1") }, { member: "" }], holds: [""], report: 3 }, ["network"])).toEqual([
      "`pending` cannot set op, which chant writes",
      "`overriders` must be a list of principals",
      "member network is also a run's target; a digest member that is no run needs a name of its own",
      "each of `members` needs a member and a planDigest",
      "`holds` must be a list of reasons, each a line saying why the wave waits for a person",
      "`report` must be the report's text",
    ]);
    expect(opWaveAfterPlanWaveResultProblems(undefined, [])).toEqual([]);
    expect(opWaveAfterPlanResultProblems({ overriders: "carol" })).toEqual(["`overriders` must be a list of principals"]);
  });

  test("the floor is the next release", async () => {
    const entry = await import("./index");
    const { NEXT_RELEASE } = await import("../release-floors");
    expect(entry.OP_WAVE_AFTER_PLAN_WAVE_FLOOR).toBe(NEXT_RELEASE);
  });
});

