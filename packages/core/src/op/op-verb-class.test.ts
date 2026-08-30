import { describe, test, expect } from "vitest";
import { classifyOpVerbClass, isGated } from "./op-verb-class";
import type { OpConfig } from "./types";

function cfg(phases: OpConfig["phases"], onFailure?: OpConfig["onFailure"]): Pick<OpConfig, "phases" | "onFailure"> {
  return { phases, ...(onFailure ? { onFailure } : {}) };
}

describe("classifyOpVerbClass", () => {
  test("read-only for a WatchOp-shaped composition (snapshot + diff)", () => {
    const config = cfg([
      { name: "Snapshot", steps: [{ kind: "activity", fn: "lifecycleSnapshot", args: { env: "prod" } }] },
      { name: "Diff", steps: [{ kind: "activity", fn: "lifecycleDiff", args: { env: "prod" } }] },
    ]);
    expect(classifyOpVerbClass(config)).toBe("read-only");
  });

  test("read-only for an empty phase list", () => {
    expect(classifyOpVerbClass(cfg([]))).toBe("read-only");
  });

  test("mutating for nativeApply with deleteMode never", () => {
    const config = cfg([
      { name: "Apply", steps: [{ kind: "activity", fn: "nativeApply", args: { target: "kubectl", env: "prod", output: "dist", deleteMode: "never" } }] },
    ]);
    expect(classifyOpVerbClass(config)).toBe("mutating");
  });

  test("mutating for nativeApply with no deleteMode at all", () => {
    const config = cfg([
      { name: "Apply", steps: [{ kind: "activity", fn: "nativeApply", args: { target: "kubectl", env: "prod", output: "dist" } }] },
    ]);
    expect(classifyOpVerbClass(config)).toBe("mutating");
  });

  test("destructive for nativeApply with deleteMode owned-only", () => {
    const config = cfg([
      { name: "Apply", steps: [{ kind: "activity", fn: "nativeApply", args: { target: "kubectl", env: "prod", output: "dist", deleteMode: "owned-only" } }] },
    ]);
    expect(classifyOpVerbClass(config)).toBe("destructive");
  });

  test("destructive for nativeApply with deleteMode gated", () => {
    const config = cfg([
      { name: "Apply", steps: [{ kind: "activity", fn: "nativeApply", args: { target: "kubectl", env: "prod", output: "dist", deleteMode: "gated" } }] },
    ]);
    expect(classifyOpVerbClass(config)).toBe("destructive");
  });

  test("destructive for envTeardown regardless of args", () => {
    const config = cfg([{ name: "Teardown", steps: [{ kind: "activity", fn: "envTeardown", args: { env: "staging" } }] }]);
    expect(classifyOpVerbClass(config)).toBe("destructive");
  });

  test("destructive for awsDelete/azDelete/gcpDelete/chantTeardown", () => {
    for (const fn of ["awsDelete", "azDelete", "gcpDelete", "chantTeardown"]) {
      const config = cfg([{ name: "P", steps: [{ kind: "activity", fn, args: {} }] }]);
      expect(classifyOpVerbClass(config)).toBe("destructive");
    }
  });

  test("fail-closed: an unrecognized activity fn is mutating, not read-only", () => {
    const config = cfg([{ name: "P", steps: [{ kind: "activity", fn: "someBespokeCustomActivity", args: {} }] }]);
    expect(classifyOpVerbClass(config)).toBe("mutating");
  });

  test("a single destructive step outranks other read-only/mutating steps in the same Op", () => {
    const config = cfg([
      { name: "Diff", steps: [{ kind: "activity", fn: "lifecycleDiff", args: { env: "prod" } }] },
      { name: "Teardown", steps: [{ kind: "activity", fn: "envTeardown", args: { env: "prod" } }] },
    ]);
    expect(classifyOpVerbClass(config)).toBe("destructive");
  });

  test("checks onFailure phases too", () => {
    const config = cfg(
      [{ name: "Apply", steps: [{ kind: "activity", fn: "lifecycleDiff", args: { env: "prod" } }] }],
      [{ name: "Rollback", steps: [{ kind: "activity", fn: "envTeardown", args: { env: "prod" } }] }],
    );
    expect(classifyOpVerbClass(config)).toBe("destructive");
  });

  test("looks inside an effect step's nested activity steps", () => {
    const config = cfg([
      {
        name: "Seed",
        steps: [
          {
            kind: "effect",
            receipt: { name: "seeded", lexicon: "aws" } as never,
            steps: [{ kind: "activity", fn: "nativeApply", args: { target: "kubectl", env: "prod", output: "dist", deleteMode: "gated" } }],
          },
        ],
      },
    ]);
    expect(classifyOpVerbClass(config)).toBe("destructive");
  });
});

describe("isGated", () => {
  test("false with no gate step", () => {
    expect(isGated(cfg([{ name: "Apply", steps: [{ kind: "activity", fn: "nativeApply", args: {} }] }]))).toBe(false);
  });

  test("true with a gate step in the main phases", () => {
    expect(
      isGated(
        cfg([
          { name: "Approve", steps: [{ kind: "gate", signalName: "approve-x" }] },
          { name: "Apply", steps: [{ kind: "activity", fn: "nativeApply", args: {} }] },
        ]),
      ),
    ).toBe(true);
  });

  test("true with a gate step in onFailure", () => {
    expect(
      isGated(
        cfg(
          [{ name: "Apply", steps: [{ kind: "activity", fn: "nativeApply", args: {} }] }],
          [{ name: "Rollback", steps: [{ kind: "gate", signalName: "approve-rollback" }] }],
        ),
      ),
    ).toBe(true);
  });
});
