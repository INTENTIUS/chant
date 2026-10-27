import { describe, expect, test } from "vitest";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { PLUNGE_PLAN_MOVED_EXIT, PULUMI_EXIT, pulumiExitOf, pulumiPlanMoved } from "./exit-codes";

describe("pulumi and plunge exit statuses on chant's table (#4553)", () => {
  test("plunge's moved plan is chant's moved code", () => {
    expect(pulumiExitOf(PLUNGE_PLAN_MOVED_EXIT)).toBe(CHANT_EXIT.moved);
    expect(pulumiPlanMoved(40)).toBe(true);
  });

  test("a policy violation is denied, and changes under --expect-no-changes are drift", () => {
    expect(pulumiExitOf(PULUMI_EXIT.policyViolation)).toBe(CHANT_EXIT.denied);
    expect(pulumiExitOf(PULUMI_EXIT.noChanges)).toBe(CHANT_EXIT.drift);
  });

  test("no raw Pulumi code passes through: authentication's 3 is failed, never waiting", () => {
    expect(pulumiExitOf(PULUMI_EXIT.authentication)).toBe(CHANT_EXIT.failed);
    for (const code of [1, 2, 4, 6, 8, 9, 10, 255, 99, null, undefined]) expect(pulumiExitOf(code)).toBe(CHANT_EXIT.failed);
    expect(pulumiExitOf(0)).toBe(CHANT_EXIT.done);
  });
});
