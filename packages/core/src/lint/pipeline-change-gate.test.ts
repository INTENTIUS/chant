import { describe, expect, test } from "vitest";
import type { Component, Phase } from "../components/component";
import {
  classifyComponentPipelineChange,
  classifyPipelineChange,
  componentVerbSet,
  evaluatePipelineChangeGate,
} from "./pipeline-change-gate";

const KNOWN: ReadonlySet<string> = new Set(["cfn-deploy", "publish-image", "wait-for-stack"]);

const component = (deploy: Phase[]): Component => ({
  name: "widget",
  dependsOn: [],
  deploy,
});

const ordinary = (): Component =>
  component([{ phase: "Deploy", steps: [{ kind: "cfn-deploy" }, { kind: "wait-for-stack" }] }]);

const withShell = (): Component =>
  component([{ phase: "Deploy", steps: [{ kind: "shell", cmd: "echo hi", reason: "no capability yet" }] }]);

const withUnregisteredVerb = (): Component =>
  component([{ phase: "Deploy", steps: [{ kind: "some-new-verb" }] }]);

describe("classifyComponentPipelineChange (#1569)", () => {
  test("a composition of only registry verbs is not a pipeline change", () => {
    const result = classifyComponentPipelineChange(ordinary(), { knownKinds: KNOWN });
    expect(result).toEqual({ pipelineChange: false, reasons: [] });
  });

  test("any shell step trips the class unconditionally, even with a declared reason", () => {
    const result = classifyComponentPipelineChange(withShell(), { knownKinds: KNOWN });
    expect(result.pipelineChange).toBe(true);
    expect(result.reasons).toEqual([{ kind: "shell-step", phaseName: "Deploy" }]);
  });

  test("a verb outside the known registry trips the class", () => {
    const result = classifyComponentPipelineChange(withUnregisteredVerb(), { knownKinds: KNOWN });
    expect(result.pipelineChange).toBe(true);
    expect(result.reasons).toEqual([{ kind: "unregistered-verb", stepKind: "some-new-verb", phaseName: "Deploy" }]);
  });

  test("gate steps are never mistaken for an escape hatch", () => {
    const withGate = component([
      { phase: "Approve", steps: [{ kind: "gate", signalName: "release-approved" }] },
    ]);
    expect(classifyComponentPipelineChange(withGate, { knownKinds: KNOWN })).toEqual({
      pipelineChange: false,
      reasons: [],
    });
  });

  test("nested fan-out phases are walked, same as COMP005/COMP006", () => {
    const nested = component([
      {
        phase: "Fanout",
        steps: [{ phase: "per-region", steps: [{ kind: "shell", cmd: "aws sts get-caller-identity", reason: "no capability" }] }],
      },
    ]);
    const result = classifyComponentPipelineChange(nested, { knownKinds: KNOWN });
    expect(result.pipelineChange).toBe(true);
    expect(result.reasons).toEqual([{ kind: "shell-step", phaseName: "per-region" }]);
  });

  test("without an explicit registry, falls back to core's starter verbs (same fallback as COMP005)", () => {
    // cfn-deploy is not in core's starter set (it's an aws-lexicon leaf), so
    // this asserts the fallback is core's own set, not "everything passes".
    const result = classifyComponentPipelineChange(ordinary());
    expect(result.pipelineChange).toBe(true);
    expect(result.reasons.some((r) => r.kind === "unregistered-verb" && r.stepKind === "cfn-deploy")).toBe(true);
  });
});

describe("componentVerbSet (#1569)", () => {
  test("collects every non-gate step kind, excluding gate steps", () => {
    const c = component([
      {
        phase: "Deploy",
        steps: [{ kind: "cfn-deploy" }, { kind: "gate", signalName: "go" }, { kind: "wait-for-stack" }],
      },
    ]);
    expect(componentVerbSet(c)).toEqual(new Set(["cfn-deploy", "wait-for-stack"]));
  });
});

describe("classifyPipelineChange (#1569)", () => {
  test("no `before` (a brand-new component): reports only the single-composition findings, no verb-set-changed", () => {
    const result = classifyPipelineChange(undefined, ordinary(), { knownKinds: KNOWN });
    expect(result).toEqual({ pipelineChange: false, reasons: [] });
  });

  test("identical verb set before and after is not a pipeline change even with `before` present", () => {
    const result = classifyPipelineChange(ordinary(), ordinary(), { knownKinds: KNOWN });
    expect(result).toEqual({ pipelineChange: false, reasons: [] });
  });

  test("adding a verb to the composition trips verb-set-changed", () => {
    const after = component([
      { phase: "Deploy", steps: [{ kind: "cfn-deploy" }, { kind: "wait-for-stack" }, { kind: "publish-image" }] },
    ]);
    const result = classifyPipelineChange(ordinary(), after, { knownKinds: KNOWN });
    expect(result.pipelineChange).toBe(true);
    expect(result.reasons).toEqual([{ kind: "verb-set-changed", added: ["publish-image"], removed: [] }]);
  });

  test("removing a verb from the composition trips verb-set-changed", () => {
    const after = component([{ phase: "Deploy", steps: [{ kind: "cfn-deploy" }] }]);
    const result = classifyPipelineChange(ordinary(), after, { knownKinds: KNOWN });
    expect(result.reasons).toEqual([{ kind: "verb-set-changed", added: [], removed: ["wait-for-stack"] }]);
  });

  test("a verb-set change composes with a shell finding on the same change, both reported", () => {
    const after = withShell();
    const result = classifyPipelineChange(ordinary(), after, { knownKinds: KNOWN });
    expect(result.pipelineChange).toBe(true);
    expect(result.reasons).toContainEqual({ kind: "shell-step", phaseName: "Deploy" });
    expect(result.reasons).toContainEqual({
      kind: "verb-set-changed",
      added: ["shell"],
      removed: ["cfn-deploy", "wait-for-stack"],
    });
  });
});

describe("evaluatePipelineChangeGate (#1569)", () => {
  test("an ordinary composition routes nowhere", () => {
    const verdict = evaluatePipelineChangeGate(undefined, ordinary(), "human-always", { knownKinds: KNOWN });
    expect(verdict.route).toBe("none");
    expect(verdict.pipelineChange).toBe(false);
  });

  test('defaults to "human-always" — a pipeline change never free-runs unless the caller opts into "stricter-gate"', () => {
    const verdict = evaluatePipelineChangeGate(undefined, withShell(), undefined, { knownKinds: KNOWN });
    expect(verdict.route).toBe("human-always");
    expect(verdict.pipelineChange).toBe(true);
  });

  test('"stricter-gate" routes a pipeline change to the named stricter class instead', () => {
    const verdict = evaluatePipelineChangeGate(undefined, withShell(), "stricter-gate", { knownKinds: KNOWN });
    expect(verdict.route).toBe("stricter-gate");
  });
});
