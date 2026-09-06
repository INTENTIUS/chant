/**
 * TerraformWatchOp composite tests (#2087): the phases, the Drift outcome
 * attribute, the three finding modes, the schedule, and the hard rule that
 * only the `-no-color` plan text can reach an issue or PR body.
 */

import { describe, test, expect } from "vitest";
import {
  isStepOutputRef,
  collectStepOutputRefs,
  type ActivityStep,
  type OpConfig,
  type StepDefinition,
} from "@intentius/chant/op";

import { TerraformWatchOp } from "./terraform-watch-op";

/** The Op's declared config, which is what `chant build` serializes. */
function props(config: Parameters<typeof TerraformWatchOp>[0]): OpConfig {
  return (TerraformWatchOp(config).op as unknown as { props: OpConfig }).props;
}

const phaseNames = (op: OpConfig): string[] => op.phases.map((p) => p.name);
const isActivity = (s: StepDefinition): s is ActivityStep => s.kind === "activity";
const steps = (op: OpConfig): ActivityStep[] => op.phases.flatMap((p) => p.steps.filter(isActivity));

describe("TerraformWatchOp phases (#2087)", () => {
  test("report mode is Init then Plan, and opens nothing", () => {
    const op = props({ name: "app-watch", root: "app" });
    expect(phaseNames(op)).toEqual(["Init", "Plan"]);
    expect(steps(op).map((s) => s.fn)).toEqual(["terraformInit", "terraformPlan"]);
    expect(steps(op).some((s) => s.fn === "reconcilePr")).toBe(false);
  });

  test('"report" is the default finding mode', () => {
    expect(phaseNames(props({ name: "app-watch", root: "app", findingMode: "report" }))).toEqual(
      phaseNames(props({ name: "app-watch", root: "app" })),
    );
  });

  test("every step names the configured root", () => {
    for (const step of steps(props({ name: "app-watch", root: "app", findingMode: "issue" }))) {
      if (step.fn === "reconcilePr") continue;
      expect(step.args?.root).toBe("app");
    }
  });

  test("the Plan step reports drift as a search attribute", () => {
    const plan = props({ name: "app-watch", root: "app" }).phases[1].steps[0] as ActivityStep;
    expect(plan.fn).toBe("terraformPlan");
    expect(plan.id).toBe("plan");
    // `terraformPlanCommand` always emits -detailed-exitcode, which is what
    // makes `changed` answerable at all. See ../op/activities/terraform.ts.
    expect(plan.outcomeAttribute).toEqual({ name: "Drift", from: "changed" });
    expect(plan.args?.planFile).toBe("chant.tfplan");
  });

  test("cwd and upgrade ride the steps that take them", () => {
    const op = props({ name: "app-watch", root: "app", cwd: "/repo", upgrade: true });
    const [init, plan] = steps(op);
    expect(init.args).toMatchObject({ root: "app", cwd: "/repo", upgrade: true });
    expect(plan.args).toMatchObject({ root: "app", cwd: "/repo" });
    expect(plan.args?.upgrade).toBeUndefined();
  });

  test("no cwd means no cwd arg, so each step reads the process's own", () => {
    for (const step of steps(props({ name: "app-watch", root: "app" }))) {
      expect(step.args && "cwd" in step.args).toBe(false);
    }
  });
});

describe("TerraformWatchOp finding modes (#2087)", () => {
  const findingStep = (mode: "issue" | "pull-request"): ActivityStep => {
    const op = props({ name: "app-watch", root: "app", findingMode: mode });
    expect(phaseNames(op)).toEqual(["Init", "Plan", "Report"]);
    return op.phases[2].steps[0] as ActivityStep;
  };

  test("issue mode opens an issue through reconcilePr and surfaces its URL", () => {
    const step = findingStep("issue");
    expect(step.fn).toBe("reconcilePr");
    expect(step.args?.mode).toBe("issue");
    expect(step.args?.env).toBe("app");
    expect(step.outcomeAttribute).toEqual({ name: "Issue", from: "issueUrl" });
  });

  test("pull-request mode opens a PR through the same activity", () => {
    const step = findingStep("pull-request");
    expect(step.fn).toBe("reconcilePr");
    expect(step.args?.mode).toBe("pull-request");
    expect(step.outcomeAttribute).toEqual({ name: "PR", from: "prUrl" });
  });

  test("the finding step derives no plan of its own", () => {
    // `entries: []` is what stops reconcilePr shelling to `chant lifecycle
    // plan --json`: the finding is already written by the time it runs.
    expect(findingStep("issue").args?.entries).toEqual([]);
  });

  test("title defaults to the root and can be overridden, and branch only rides when given", () => {
    expect(findingStep("issue").args?.title).toBe('Terraform drift in root "app"');
    const custom = props({
      name: "app-watch",
      root: "app",
      findingMode: "pull-request",
      title: "Nightly drift",
      branch: "chant/tf-drift",
    }).phases[2].steps[0] as ActivityStep;
    expect(custom.args?.title).toBe("Nightly drift");
    expect(custom.args?.branch).toBe("chant/tf-drift");
    expect(findingStep("issue").args && "branch" in findingStep("issue").args!).toBe(false);
  });
});

describe("TerraformWatchOp posts the human plan and never the plan JSON (#2087)", () => {
  for (const mode of ["issue", "pull-request"] as const) {
    test(`${mode}: the body is a reference to the Plan step's -no-color text`, () => {
      const op = props({ name: "app-watch", root: "app", findingMode: mode });
      const report = op.phases[2].steps[0] as ActivityStep;
      const body = report.args?.body;
      expect(isStepOutputRef(body)).toBe(true);
      expect(body).toMatchObject({ step: "plan", path: "text" });
    });

    test(`${mode}: no reference to the plan JSON reaches the finding step`, () => {
      // `TerraformPlanResult.json` is `terraform show -json` over the saved
      // plan: every attribute value the plan touches, provider credentials
      // included. The only other thing that could carry it is a literal, so
      // both the references and the serialized args are checked.
      const op = props({ name: "app-watch", root: "app", findingMode: mode });
      const report = op.phases[2].steps[0] as ActivityStep;
      const paths = collectStepOutputRefs(report.args).map((r) => r.path);
      expect(paths).toEqual(["text"]);
      expect(paths).not.toContain("json");
      expect(JSON.stringify(report.args)).not.toContain("json");
    });
  }

  test("the whole Op references exactly one field of the plan", () => {
    const op = props({ name: "app-watch", root: "app", findingMode: "issue" });
    const refs = op.phases.flatMap((p) => p.steps.filter(isActivity)).flatMap((s) => collectStepOutputRefs(s.args));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ step: "plan", path: "text" });
  });
});

describe("TerraformWatchOp schedule (#2087)", () => {
  test("omitting `schedule` returns no schedule", () => {
    const result = TerraformWatchOp({ name: "app-watch", root: "app" });
    expect(result.schedule).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, "schedule")).toBe(false);
  });

  test("a cron returns a Temporal::Schedule beside the Op", () => {
    const { op, schedule } = TerraformWatchOp({
      name: "app-watch",
      root: "app",
      schedule: "0 6 * * *",
    });
    expect(schedule).toBeDefined();
    expect(schedule!.entityType).toBe("Temporal::Schedule");
    expect(schedule!.lexicon).toBe("temporal");
    expect((schedule as unknown as { props: Record<string, unknown> }).props).toEqual({
      scheduleId: "app-watch-schedule",
      spec: { cronExpressions: ["0 6 * * *"] },
      action: { workflowType: "appWatchWorkflow", taskQueue: "app-watch" },
    });
    expect((op as unknown as { props: OpConfig }).props.taskQueue).toBe("app-watch");
  });

  test("an explicit taskQueue reaches both the Op and the schedule action", () => {
    const { op, schedule } = TerraformWatchOp({
      name: "app-watch",
      root: "app",
      schedule: "0 6 * * *",
      taskQueue: "infra",
    });
    expect((op as unknown as { props: OpConfig }).props.taskQueue).toBe("infra");
    expect(
      ((schedule as unknown as { props: { action: { taskQueue: string } } }).props.action).taskQueue,
    ).toBe("infra");
  });
});
