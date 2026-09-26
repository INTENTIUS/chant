import { describe, test, expect } from "vitest";
import {
  ConvergeOp,
  eq,
  isActivityContract,
  loadActivityContracts,
  run,
  validateActivitySteps,
  validateStepOutputRefs,
  when,
  type ActivityContract,
  type ResourceSymptom,
} from "@intentius/chant/op";
import * as contracts from "./activity-contracts";
import * as activities from "./activities";
import { spriteServicesObserve, spriteServiceRestart } from "./builders";

const CONTRACTS: Map<string, ActivityContract> = new Map(
  Object.values(contracts).filter(isActivityContract).map((c) => [c.name, c]),
);

const op = (steps: unknown[]) => ({ name: "restart-service", phases: [{ name: "Phase", steps: steps as never[] }] });

describe("fly activity contracts (#2843)", () => {
  test("the module exports nothing but contracts, each for an exported activity, each with a return schema", () => {
    for (const [key, value] of Object.entries(contracts)) {
      expect(isActivityContract(value), `${key} is not an ActivityContract`).toBe(true);
      const c = value as ActivityContract;
      expect(typeof (activities as unknown as Record<string, unknown>)[c.name], `${c.name} is not an exported activity`).toBe("function");
      expect(c.returns, `${c.name} declares no return schema`).toBeDefined();
    }
    expect([...CONTRACTS.keys()].sort()).toEqual(["spriteServiceRestart", "spriteServicesObserve"]);
  });

  test("a ConvergeOp observing spriteServicesObserve passes OPS012 and OPS013 (the guide's example)", () => {
    const { op: converge } = ConvergeOp({
      name: "converge",
      env: "box",
      dial: "apply",
      schedule: "* * * * *",
      observe: spriteServicesObserve({ servicesFile: "services.json" }),
      rules: [when<ResourceSymptom>(eq("status", "drifted"), run("restart-service"), { id: "restart-drifted", why: "restart it" })],
    });
    const config = converge.props as never;
    expect(validateActivitySteps(config, CONTRACTS)).toEqual([]);
    expect(validateStepOutputRefs(config, CONTRACTS)).toEqual([]);
  });

  test("without the contracts, the same Op fails OPS013 (the bug)", () => {
    const { op: converge } = ConvergeOp({
      name: "converge",
      env: "box",
      observe: spriteServicesObserve({ servicesFile: "services.json" }),
      rules: [when<ResourceSymptom>(eq("status", "drifted"), run("restart-service"), { id: "restart-drifted", why: "restart it" })],
    });
    const issues = validateStepOutputRefs(converge.props as never, new Map());
    expect(issues.some((i) => i.message.includes("spriteServicesObserve"))).toBe(true);
  });

  test("the restart step's args validate, and a misspelled key is an error", () => {
    expect(validateActivitySteps(op([spriteServiceRestart({ servicesFile: "services.json", waitMs: 30_000 })]), CONTRACTS)).toEqual([]);
    const issues = validateActivitySteps(op([{ kind: "activity", fn: "spriteServiceRestart", args: { servicefile: "services.json" } }]), CONTRACTS);
    expect(issues.some((i) => i.message.includes("servicefile"))).toBe(true);
  });

  test("loadActivityContracts finds them at @intentius/chant-lexicon-fly/op/activity-contracts", async () => {
    const loaded = await loadActivityContracts(["fly"]);
    expect(loaded.get("spriteServicesObserve")?.returns).toBeDefined();
    expect(loaded.get("spriteServiceRestart")?.returns).toBeDefined();
  });
});
