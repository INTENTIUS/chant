import { describe, expect, test } from "vitest";
import { CHANT_EXIT, chantExitName } from "./exit-codes";
import { PLAN_MOVED_EXIT_CODE, isPlanMovedError } from "./components/capability";
import { GATED_EXIT_CODE } from "./cli/handlers/run";
import { DRIFT_EXIT_CODE } from "./op/types";
import { PR_ENV_EXIT } from "./components/pr-environment";

describe("the exit-code table (#4553)", () => {
  test("has one name per code, 0 to 8", () => {
    expect(Object.values(CHANT_EXIT)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(chantExitName(4)).toBe("moved");
    expect(chantExitName(40)).toBeUndefined();
  });

  test("a moved plan exits apart from a waiting run", () => {
    expect(PLAN_MOVED_EXIT_CODE).toBe(CHANT_EXIT.moved);
    expect(GATED_EXIT_CODE).toBe(CHANT_EXIT.waiting);
    expect(PLAN_MOVED_EXIT_CODE).not.toBe(GATED_EXIT_CODE);
  });

  test("the commands that kept their own constant take them from the table", () => {
    expect(DRIFT_EXIT_CODE).toBe(CHANT_EXIT.drift);
    expect(PR_ENV_EXIT).toEqual({ done: 0, failed: 1, waiting: 3, held: 5 });
  });

  test("an error marked with the old moved code still reads as moved, and 4 on its own does not", () => {
    expect(isPlanMovedError({ planMoved: true })).toBe(true);
    expect(isPlanMovedError({ exitCode: 3 })).toBe(true);
    expect(isPlanMovedError({ exitCode: 4 })).toBe(false);
  });
});
