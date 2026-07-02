import { describe, test, expect } from "vitest";
import { LexiconUpgradeOp, IN_SCOPE_LEXICONS } from "./lexicon-upgrade-op";

describe("LexiconUpgradeOp composite (#527)", () => {
  test("one-shot form: op only, no schedule", () => {
    const { op, schedule } = LexiconUpgradeOp({ lexicon: "aws" });
    expect(op).toBeDefined();
    expect(schedule).toBeUndefined();
  });

  test("default name is <lexicon>-upgrade", () => {
    const { op } = LexiconUpgradeOp({ lexicon: "k8s" });
    const cfg = (op as unknown as { props: { name: string } }).props;
    expect(cfg.name).toBe("k8s-upgrade");
  });

  test("dispatches through the lexiconUpgrade activity with the lexicon + mode", () => {
    const { op } = LexiconUpgradeOp({ lexicon: "gitlab", onFinding: "pull-request" });
    const config = (op as unknown as { props: Record<string, unknown> }).props;
    const phases = config.phases as Array<{ steps: Array<Record<string, unknown>> }>;
    const step = phases[0].steps[0];
    expect(step.fn).toBe("lexiconUpgrade");
    expect((step.args as { lexicon: string }).lexicon).toBe("gitlab");
    expect((step.args as { mode: string }).mode).toBe("pull-request");
  });

  test("report is the default finding mode", () => {
    const { op } = LexiconUpgradeOp({ lexicon: "azure" });
    const config = (op as unknown as { props: Record<string, unknown> }).props;
    const phases = config.phases as Array<{ steps: Array<{ args: { mode: string } }> }>;
    expect(phases[0].steps[0].args.mode).toBe("report");
  });

  test("scheduled form: op + weekly TemporalSchedule", () => {
    const { op, schedule } = LexiconUpgradeOp({
      lexicon: "k8s",
      schedule: "0 6 * * 1",
      onFinding: "pull-request",
    });
    expect(op).toBeDefined();
    expect(schedule).toBeDefined();
    const props = (schedule as unknown as { props: Record<string, unknown> }).props;
    expect(props.scheduleId).toBe("k8s-upgrade-schedule");
    expect((props.spec as { cronExpressions: string[] }).cronExpressions).toEqual(["0 6 * * 1"]);
    expect((props.action as { workflowType: string }).workflowType).toBe("k8sUpgradeWorkflow");
  });

  test("surfaces HasUpgrade as an outcome search attribute", () => {
    const { op } = LexiconUpgradeOp({ lexicon: "docker" });
    const config = (op as unknown as { props: Record<string, unknown> }).props;
    const phases = config.phases as Array<{ steps: Array<{ outcomeAttribute?: { name: string; from: string } }> }>;
    expect(phases[0].steps[0].outcomeAttribute).toEqual({ name: "HasUpgrade", from: "hasUpgrade" });
  });

  test("in-scope set is exactly the 7 lexicons (helm/temporal/forgejo excluded)", () => {
    expect([...IN_SCOPE_LEXICONS].sort()).toEqual(
      ["aws", "azure", "docker", "gcp", "github", "gitlab", "k8s"].sort(),
    );
    expect(IN_SCOPE_LEXICONS).not.toContain("helm");
    expect(IN_SCOPE_LEXICONS).not.toContain("temporal");
    expect(IN_SCOPE_LEXICONS).not.toContain("forgejo");
  });

  test("rejects out-of-scope lexicons at construction", () => {
    for (const l of ["helm", "temporal", "forgejo"]) {
      expect(() => LexiconUpgradeOp({ lexicon: l as never })).toThrow(/not in scope/);
    }
  });
});
