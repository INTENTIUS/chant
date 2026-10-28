import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWavesSpec, type OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveExec, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort, type GateLedgerPort } from "./gate";
import { composeChangeSet, type ChangeSetDocument, type ChangeSetMember } from "../change-set";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import { productWavesSpec } from "../components/product-pipeline";

// The pull request's approval as an op-waves approval source (#4550, ruling B):
// plywood's preset applies every wave its approved change set covers, and a wave
// whose plan moved waits at its own gate.

const digest = (n: string) => `sha256:${n.repeat(64)}`;
const member = (name: string, planDigest: string): ChangeSetMember =>
  ({ member: name, lexicon: "pulumi", planner: "pulumi", status: "planned", planDigest, holes: [] }) as ChangeSetMember;
const doc = (planDigest: string, entries: ChangeSetDocument["entries"] = []): ChangeSetDocument => composeChangeSet([{ member: member("shop-dev", planDigest), entries }]);
/** A plan that does more than the approved one: a new digest planning the same entries is still covered (planCoveredBy). */
const movedDoc = (planDigest: string): ChangeSetDocument =>
  doc(planDigest, [{ member: "shop-dev", lexicon: "pulumi", planner: "pulumi", address: "urn:shop-dev::bucket", type: "aws:s3/bucket:Bucket", action: "create", attributes: [] }] as unknown as ChangeSetDocument["entries"]);

const plywood = { product: "plywood", op: "pulumi-up", prGate: "up", gateName: "wave-{k}", approval: "pull-request" as const };
const spec: OpWavesSpec = productWavesSpec(
  {
    name: "waves",
    op: "pulumi-up",
    planWave: ["tool", "plan-wave", "{runs}", "{plans}"],
    applyWave: ["tool", "apply-wave", "{runs}", "{plans}"],
    waves: [{ name: "dev", runs: [{ target: "shop-dev" }] }],
  },
  plywood,
);

function harness(waveDoc: ChangeSetDocument) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-pr-"));
  const exec: OpWaveExec = (argv, dir) => {
    if (argv[1] === "plan-wave") writeFileSync(join(dir, argv[3]!), JSON.stringify({ runs: [{ target: "shop-dev", planDigest: waveDoc.members[0]!.planDigest }], changeSet: waveDoc }));
    return 0;
  };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
  return { cwd, exec, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

const approval = (approved: ChangeSetDocument): GateResolutionRecord =>
  ({ version: 1, kind: "resolution", op: "pulumi-up", gate: "up", resolvedBy: "github:alice", timestamp: "2026-10-27T01:00:00Z", planDigest: approved.digest, changeSet: approved.digest }) as unknown as GateResolutionRecord;

const run = (h: ReturnType<typeof harness>, gates: GateLedgerPort, stored: ChangeSetDocument[]) =>
  runOpWave({
    spec,
    specFile: ".chant/op-waves/pulumi-up.spec.json",
    wave: 1,
    cwd: h.cwd,
    exec: h.exec,
    show: h.show,
    gates,
    now: "2026-10-27T02:00:00Z",
    changeSets: async (d) => stored.find((x) => x.digest === d),
    log: () => undefined,
  });

describe("the pull request's approval as an op-waves approval source (#4550)", () => {
  test("the words name the op, the wave gates and the pull request's gate", () => {
    expect(() => assertOpWavesSpec(spec)).not.toThrow();
    expect(spec.name).toBe("pulumi-up");
    expect(spec.gateName).toBe("wave-{k}");
    expect(spec.waves[0]!.approval).toBe("pull-request");
    expect(spec.approvals?.pullRequest).toEqual({ gate: "up" });
  });

  test("a wave whose plans the approved change set covers applies under it", async () => {
    const approved = doc(digest("a"));
    const h = harness(approved);
    try {
      const result = await run(h, memoryGateLedgerPort({ resolutions: [approval(approved)] }), [approved]);
      expect(result.exitCode).toBe(0);
      expect(result.decision).toMatchObject({ status: "approved", via: "pull-request", gate: "wave-1", coveredBy: { digest: approved.digest } });
    } finally {
      h.done();
    }
  });

  test("a wave whose plan moved waits at its own gate", async () => {
    const approved = doc(digest("a"));
    const moved = movedDoc(digest("c"));
    const h = harness(moved);
    try {
      const result = await run(h, memoryGateLedgerPort({ resolutions: [approval(approved)] }), [approved]);
      expect(result.exitCode).toBe(3);
      expect(result.decision?.status).toBe("waiting");
      expect(result.decision?.gate).toBe("wave-1");
      expect(result.decision?.coveredBy?.reason).toBeTruthy();
    } finally {
      h.done();
    }
  });

  test("with no approval at the pull request's gate the wave waits", async () => {
    const h = harness(doc(digest("a")));
    try {
      const result = await run(h, memoryGateLedgerPort(), []);
      expect(result.exitCode).toBe(3);
      expect(result.decision?.coveredBy?.reason).toMatch(/no approval stands at up/);
    } finally {
      h.done();
    }
  });
});

describe("planWave and applyWave run by the caller (#4588)", () => {
  test("waveExec runs both steps in process, and exec runs neither", async () => {
    const approved = doc(digest("a"));
    const h = harness(approved);
    const calls: string[] = [];
    try {
      const result = await runOpWave({
        spec,
        specFile: ".chant/op-waves/pulumi-up.spec.json",
        wave: 1,
        cwd: h.cwd,
        exec: () => {
          throw new Error("the steps must not spawn");
        },
        waveExec: async (argv, dir) => {
          calls.push(argv[1]!);
          return h.exec(argv, dir);
        },
        show: h.show,
        gates: memoryGateLedgerPort({ resolutions: [approval(approved)] }),
        now: "2026-10-27T02:00:00Z",
        changeSets: async (d) => (d === approved.digest ? approved : undefined),
        log: () => undefined,
      });
      expect(result.exitCode).toBe(0);
      expect(calls).toEqual(["plan-wave", "apply-wave"]);
      expect(result.applied).toEqual(["shop-dev"]);
    } finally {
      h.done();
    }
  });
});
