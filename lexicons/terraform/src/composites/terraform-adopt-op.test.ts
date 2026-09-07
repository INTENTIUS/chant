/**
 * TerraformAdoptOp composite tests (#2105): the four phases, the gate that is
 * always there, the two references the Adopt step takes off the ledger, and
 * the rule an adoption Op exists to keep — an ambiguous match is reported and
 * never written.
 */

import { describe, test, expect } from "vitest";
import {
  collectStepOutputRefs,
  isStepOutputRef,
  type ActivityStep,
  type GateStep,
  type OpConfig,
  type StepDefinition,
} from "@intentius/chant/op";

import { TerraformAdoptOp } from "./terraform-adopt-op";

function props(config: Parameters<typeof TerraformAdoptOp>[0]): OpConfig {
  return (TerraformAdoptOp(config).op as unknown as { props: OpConfig }).props;
}

const phaseNames = (op: OpConfig): string[] => op.phases.map((p) => p.name);
const isActivity = (s: StepDefinition): s is ActivityStep => s.kind === "activity";
const steps = (op: OpConfig): ActivityStep[] => op.phases.flatMap((p) => p.steps.filter(isActivity));
const base = { name: "estate-adopt", root: "estate" };

describe("TerraformAdoptOp phases (#2105)", () => {
  test("Check, Ledger, Gate, Adopt, in that order", () => {
    const op = props(base);
    expect(phaseNames(op)).toEqual(["Check", "Ledger", "Gate", "Adopt"]);
    expect(steps(op).map((s) => s.fn)).toEqual(["choudoufuLiveCheck", "choudoufuLivePlan", "choudoufuAdopt"]);
  });

  test("Check runs live-check first, and reports whether the root was refused", () => {
    const check = props(base).phases[0].steps[0] as ActivityStep;
    expect(check.fn).toBe("choudoufuLiveCheck");
    expect(check.outcomeAttribute).toEqual({ name: "Refused", from: "refused" });
    // No cloud calls, so this is the cheapest place to learn the root cannot
    // move under markers at all.
    expect(check.profile).toBe("fastIdempotent");
  });

  test("Ledger is the -adoption-only live plan, and publishes both counts", () => {
    const ledger = props(base).phases[1].steps[0] as ActivityStep;
    expect(ledger.fn).toBe("choudoufuLivePlan");
    expect(ledger.id).toBe("ledger");
    expect(ledger.args?.adoptionOnly).toBe(true);
    expect(ledger.outcomeAttribute).toEqual([
      { name: "Adoptable", from: "adoptable" },
      { name: "Ambiguous", from: "ambiguous" },
    ]);
  });

  test("every step names the configured root", () => {
    for (const step of steps(props(base))) expect(step.args?.root).toBe("estate");
  });

  test("cwd rides every step, and no cwd means no cwd arg", () => {
    for (const step of steps(props({ ...base, cwd: "/repo" }))) expect(step.args?.cwd).toBe("/repo");
    for (const step of steps(props(base))) expect(step.args && "cwd" in step.args).toBe(false);
  });

  test("an explicit estate rides the Ledger step only", () => {
    const op = props({ ...base, estate: "prod-networking" });
    expect((op.phases[1].steps[0] as ActivityStep).args?.estate).toBe("prod-networking");
    expect((op.phases[0].steps[0] as ActivityStep).args?.estate).toBeUndefined();
  });
});

describe("TerraformAdoptOp gates on the ledger (#2105)", () => {
  const gateOf = (op: OpConfig): GateStep => {
    const step = op.phases[2].steps[0];
    expect(step.kind).toBe("gate");
    return step as GateStep;
  };

  test("the gate is always emitted: there is no ungated adoption", () => {
    // Unlike TerraformApplyOp there is no `gate: "never"` here. Adoption moves
    // the estate's boundary onto resources it did not own, which is not a
    // thing to do unattended.
    expect(gateOf(props(base)).gate).toBe("approve-estate-adopt");
    expect(Object.keys(TerraformAdoptOp(base))).toEqual(["op"]);
  });

  test("the description names the ledger as the approval subject", () => {
    const description = gateOf(props(base)).description!;
    expect(description).toContain("adoption ledger");
    expect(description).toContain("tofu-estate and tofu-address");
    expect(description).toContain("an ambiguous address is never adopted");
  });

  // #2202: `gateName` is the option; `signalName` is read through 0.59.0.
  test("the deprecated `signalName` option still names the gate", () => {
    expect(gateOf(props({ ...base, signalName: "ok" })).gate).toBe("ok");
  });

  test("gate name, timeout and description are overridable", () => {
    const gate = gateOf(props({ ...base, gateName: "ok", gateTimeout: "2h", gateDescription: "mine" }));
    expect(gate).toMatchObject({ gate: "ok", timeout: "2h", description: "mine" });
  });

  test("no timeout given means the gate carries none, so core's own default applies", () => {
    expect(gateOf(props(base)).timeout).toBeUndefined();
  });
});

describe("TerraformAdoptOp adopts the ledger's matches and nothing else (#2105)", () => {
  const adoptStep = (op: OpConfig): ActivityStep => op.phases[3].steps[0] as ActivityStep;

  test("the Adopt step takes the ledger's adoptable set by reference", () => {
    const adopt = adoptStep(props(base));
    expect(adopt.fn).toBe("choudoufuAdopt");
    expect(isStepOutputRef(adopt.args?.adoptions)).toBe(true);
    expect(adopt.args?.adoptions).toMatchObject({ step: "ledger", path: "adoptions" });
  });

  test("an ambiguous match is handed over as `contested`, which is a separate field from `adoptions`", () => {
    // `readAdoptionLedger` never puts a contested candidate in `adoptions`, so
    // the Adopt step cannot write one however it behaves; `contested` is
    // passed so the Op's own result names what it declined and why.
    const adopt = adoptStep(props(base));
    expect(adopt.args?.contested).toMatchObject({ step: "ledger", path: "contested" });
    expect(adopt.args?.contested).not.toEqual(adopt.args?.adoptions);
  });

  test("the Adopt step reports how many resources it claimed", () => {
    expect(adoptStep(props(base)).outcomeAttribute).toEqual({ name: "Adopted", from: "adoptedCount" });
  });

  test("the Op references exactly the two ledger fields and no document", () => {
    const op = props(base);
    const refs = op.phases.flatMap((p) => p.steps.filter(isActivity)).flatMap((s) => collectStepOutputRefs(s.args));
    expect(refs.map((r) => r.path).sort()).toEqual(["adoptions", "contested"]);
    expect(refs.every((r) => r.step === "ledger")).toBe(true);
    // The bound/omissions/unowned document never leaves the Ledger step.
    expect(JSON.stringify(op)).not.toContain('"json"');
  });
});

describe("TerraformAdoptOp compensation (#2105)", () => {
  test("compensate: true throws, because un-adopting is untag", () => {
    expect(() => TerraformAdoptOp({ ...base, compensate: true })).toThrow(/un-adopting is untag/);
  });

  test("an object with no command throws the same way", () => {
    expect(() => TerraformAdoptOp({ ...base, compensate: {} })).toThrow(/TerraformAdoptOp "estate-adopt"/);
  });

  test("a supplied command becomes an onFailure Rollback phase", () => {
    const op = props({ ...base, compensate: { command: "./untag.sh" } });
    expect(op.onFailure?.map((p) => p.name)).toEqual(["Rollback"]);
    expect((op.onFailure![0].steps[0] as ActivityStep).args?.cmd).toBe("./untag.sh");
  });

  test("compensate: false and omitting it both leave no onFailure", () => {
    expect(props(base).onFailure).toBeUndefined();
    expect(props({ ...base, compensate: false }).onFailure).toBeUndefined();
  });
});

describe("TerraformAdoptOp labels (#2105, #2118)", () => {
  test("marks the Op as an adoption on a live root", () => {
    expect(props(base).labels).toEqual({
      Adopt: "true",
      TerraformRoot: "estate",
      TerraformMode: "live",
    });
  });

  test("no task queue rides on the Op (#2118)", () => {
    expect(props(base)).not.toHaveProperty("taskQueue");
  });
});
