/**
 * An agent's permit on an `enforce` gate (#5388): `identity.gates.<gate>.agentPassesAlone`
 * at base is the one way it passes a gate alone, the build warns while it is
 * set and names it for an enforced gate whose policy permits an agent, and a
 * pipeline stage gate refuses it.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPermitBuildFindings, opGatesWithApproval, stageGateNames } from "./agent-permit";
import { gatePolicyVersion, gateBaseApprovalProblems, type GatePolicyRef } from "./gate-approval";
import { resolveGateApproval } from "./local-executor";
import { agentPermitBuildCheck } from "../cli/handlers/build";
import type { GateStep } from "./types";

const TEXT = 'permit (principal is Chant::Agent, action, resource) when { context.risk == "low" };\n';
const POLICY: GatePolicyRef = { kind: "gate-policy", lexicon: "cedar", name: "ship", version: gatePolicyVersion(TEXT), text: TEXT };
const SHIP = { op: "release", gate: "ship", approval: { policy: POLICY, mode: "enforce" } };

describe("the stage gates (#5388)", () => {
  test("each stage passes through its promote, skip, urgent, rollback and soak gates", () => {
    expect([...stageGateNames([{ name: "prod" }]).keys()]).toEqual(["prod", "prod-skip", "prod-urgent", "prod-rollback", "prod-soak"]);
  });
});

describe("agentPermitBuildFindings (#5388)", () => {
  test("an entry that sets the key is warned about", () => {
    const { warnings, refusals } = agentPermitBuildFindings({ gates: { ship: { agentPassesAlone: true } }, ops: [SHIP] });
    expect(refusals).toEqual([]);
    expect(warnings).toEqual(["identity.gates.ship.agentPassesAlone is true: an agent's policy permit passes gate ship in enforce mode with no person approving"]);
  });

  test("an enforced gate whose policy permits an agent, with no key at base, gets a warning that names the key", () => {
    const { warnings } = agentPermitBuildFindings({ gates: {}, ops: [SHIP] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('set "agentPassesAlone": true in identity.gates.ship in chant.workspace.json');
  });

  test("a log-only gate, or one whose permit reads the change risk, gets no warning", () => {
    expect(agentPermitBuildFindings({ gates: {}, ops: [{ ...SHIP, approval: { ...SHIP.approval, mode: "log-only" } }] }).warnings).toEqual([]);
    expect(agentPermitBuildFindings({ gates: {}, ops: [{ ...SHIP, approval: { ...SHIP.approval, risk: { approveAbove: 0.5 } } }] }).warnings).toEqual([]);
    // The mode at base wins over the Op's.
    expect(agentPermitBuildFindings({ gates: { ship: { mode: "log-only" } }, ops: [SHIP] }).warnings).toEqual([]);
  });

  test("each stage gate with the key is refused", () => {
    const gates = Object.fromEntries(["prod", "prod-skip", "prod-urgent", "prod-rollback", "prod-soak"].map((g) => [g, { agentPassesAlone: true }]));
    const { refusals, warnings } = agentPermitBuildFindings({ gates, stages: [{ name: "dev" }, { name: "prod" }] });
    expect(warnings).toEqual([]);
    expect(refusals).toHaveLength(5);
    expect(refusals[0]).toBe("identity.gates.prod.agentPassesAlone is set, and prod is stage prod's promote gate: a stage gate passes on a person's approval, so remove the key from this entry");
    expect(refusals[4]).toContain("stage prod's soak gate");
  });

  test("the key set to false is neither warned about nor refused", () => {
    expect(agentPermitBuildFindings({ gates: { prod: { agentPassesAlone: false } }, stages: [{ name: "prod" }] })).toEqual({ warnings: [], refusals: [] });
  });

  test("the gates of a built Op are read from its phases and effects", () => {
    const op = { name: "release", phases: [{ steps: [{ kind: "effect", steps: [{ kind: "gate", gate: "ship", approval: { mode: "enforce" } }] }, { kind: "gate", gate: "plain" }] }] };
    expect(opGatesWithApproval(op)).toEqual([{ op: "release", gate: "ship", approval: { mode: "enforce" } }]);
  });
});

describe("the key at base (#5388)", () => {
  test("an entry's key must be true or false", () => {
    expect(gateBaseApprovalProblems({ agentPassesAlone: "yes" }, "identity.gates.ship")).toEqual(["`identity.gates.ship.agentPassesAlone` must be true or false"]);
    expect(gateBaseApprovalProblems({ agentPassesAlone: true }, "identity.gates.ship")).toEqual([]);
  });

  test("a run carries the key from the entry at base, and from nowhere else", () => {
    const step = { kind: "gate", gate: "ship", approval: { policy: POLICY, mode: "enforce" } } as unknown as GateStep;
    expect(resolveGateApproval(step, new Map())?.agentPassesAlone).toBeUndefined();
    expect(resolveGateApproval(step, new Map(), undefined, null, { agentPassesAlone: false })?.agentPassesAlone).toBeUndefined();
    expect(resolveGateApproval(step, new Map(), undefined, null, { agentPassesAlone: true })?.agentPassesAlone).toBe(true);
    const authored = { ...step, approval: { ...(step as { approval: object }).approval, agentPassesAlone: true } } as unknown as GateStep;
    expect(resolveGateApproval(authored, new Map())?.agentPassesAlone).toBeUndefined();
  });
});

describe("chant build reads the declaration (#5388)", () => {
  let dir: string;
  const declare = (gates: Record<string, unknown>) =>
    writeFileSync(join(dir, "chant.workspace.json"), `${JSON.stringify({ name: "shop", schema: 1, members: [], identity: { gates } }, null, 2)}\n`);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chant-agent-permit-build-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a stage gate with the key is refused at build", async () => {
    declare({ "prod-rollback": { agentPassesAlone: true } });
    const findings = await agentPermitBuildCheck(dir, { stages: [{ name: "dev" }, { name: "prod" }] });
    expect(findings?.refusals).toEqual([
      "identity.gates.prod-rollback.agentPassesAlone is set, and prod-rollback is stage prod's rollback gate: a stage gate passes on a person's approval, so remove the key from this entry",
    ]);
  });

  test("the built Ops are read for the warnings", async () => {
    declare({ ship: { agentPassesAlone: true } });
    mkdirSync(join(dir, "dist", "ops", "release"), { recursive: true });
    writeFileSync(join(dir, "dist", "ops", "release", "op.json"), JSON.stringify({ name: "release", phases: [{ steps: [{ kind: "gate", gate: "ship", approval: { policy: POLICY, mode: "enforce" } }] }] }));
    const findings = await agentPermitBuildCheck(dir, { opsDir: join(dir, "dist", "ops") });
    expect(findings).toEqual({ warnings: ["identity.gates.ship.agentPassesAlone is true: an agent's policy permit passes gate ship in enforce mode with no person approving"], refusals: [] });
  });

  test("outside a workspace there is nothing to read", async () => {
    expect(await agentPermitBuildCheck(dir, { stages: [{ name: "prod" }] })).toBeUndefined();
  });
});
