import { describe, test, expect } from "vitest";
import { z } from "zod";
import { loadActivityContracts, mergeActivityContracts } from "./activity-contract-registry";
import { activityContract, type ActivityContract } from "./activity-contract";

describe("loadActivityContracts", () => {
  test("core's own contracts load with no lexicons configured", async () => {
    const contracts = await loadActivityContracts();
    expect(contracts.get("shellCmd")).toBeDefined();
    expect(contracts.get("httpCheck")?.returns).toBeDefined();
    // The behaviour activities (#2358) ship their contracts the same way.
    expect(contracts.get("predictBehaviour")?.name).toBe("predictBehaviour");
    expect(contracts.get("behaviourFinding")?.returns).toBeDefined();
    expect(contracts.get("lifecycleDiff")?.name).toBe("lifecycleDiff");
  });

  test("a lexicon's contracts are resolved by the same subpath convention loadActivities uses", async () => {
    const contracts = await loadActivityContracts(["terraform"]);
    // terraform ships `@intentius/chant-lexicon-terraform/op/activity-contracts`.
    expect(contracts.get("terraformPlan")).toBeDefined();
    expect(contracts.get("terraformApply")).toBeDefined();
    // Core's own are still there — the lexicon adds, it does not replace.
    expect(contracts.get("shellCmd")).toBeDefined();
  });

  test("terraformPlan's declared return schema carries the fields an Apply step references", async () => {
    const contracts = await loadActivityContracts(["terraform"]);
    const returns = contracts.get("terraformPlan")?.returns as z.ZodObject<z.ZodRawShape>;
    expect(Object.keys(returns.shape)).toEqual(
      expect.arrayContaining(["planFile", "text", "changed", "adds", "changes", "destroys"]),
    );
  });

  test("an absent lexicon contributes nothing and does not throw", async () => {
    const contracts = await loadActivityContracts(["no-such-lexicon-anywhere"]);
    expect(contracts.get("shellCmd")).toBeDefined();
    expect(contracts.size).toBeGreaterThan(0);
  });

  test("a plugin member contributes contracts alongside the conventional subpath", async () => {
    const contracts = await loadActivityContracts([
      {
        name: "no-such-lexicon-anywhere",
        activityContracts: () => [activityContract("bespokeApply", z.strictObject({ target: z.string() }))],
      },
    ]);
    expect(contracts.get("bespokeApply")).toBeDefined();
  });

  test("a plugin member that throws contributes nothing rather than failing the load", async () => {
    const contracts = await loadActivityContracts([
      {
        name: "no-such-lexicon-anywhere",
        activityContracts: () => {
          throw new Error("boom");
        },
      },
    ]);
    expect(contracts.get("shellCmd")).toBeDefined();
  });

  test("the last lexicon in wins a name collision, as loadActivities does for implementations", async () => {
    const mine = activityContract("shellCmd", z.strictObject({ cmd: z.string(), extra: z.string() }));
    const contracts = await loadActivityContracts([
      { name: "no-such-lexicon-anywhere", activityContracts: () => [mine] },
    ]);
    expect(contracts.get("shellCmd")).toBe(mine);
  });
});

describe("mergeActivityContracts", () => {
  const base = new Map<string, ActivityContract>([
    ["shellCmd", activityContract("shellCmd", z.strictObject({ cmd: z.string() }))],
  ]);

  test("an undefined loaded map returns the base unchanged", () => {
    expect(mergeActivityContracts(base, undefined)).toBe(base);
  });

  test("an empty loaded map returns the base unchanged", () => {
    expect(mergeActivityContracts(base, new Map())).toBe(base);
  });

  test("loaded contracts are added without mutating the base", () => {
    const loaded = new Map<string, ActivityContract>([
      ["terraformPlan", activityContract("terraformPlan", z.strictObject({ root: z.string() }))],
    ]);
    const merged = mergeActivityContracts(base, loaded);
    expect(merged.get("terraformPlan")).toBeDefined();
    expect(merged.get("shellCmd")).toBeDefined();
    expect(base.has("terraformPlan")).toBe(false);
  });

  test("the loaded map wins a name collision — it is the one resolved against this build's lexicons", () => {
    const loaded = new Map<string, ActivityContract>([
      ["shellCmd", activityContract("shellCmd", z.strictObject({ cmd: z.string(), cwd: z.string() }))],
    ]);
    const merged = mergeActivityContracts(base, loaded);
    expect(merged.get("shellCmd")).toBe(loaded.get("shellCmd"));
  });
});
