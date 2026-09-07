/**
 * TerraformWatchOp composite tests (#2087): the phases, the Drift outcome
 * attribute, the three finding modes, the schedule, and the hard rule that
 * only the `-no-color` plan text can reach an issue or PR body.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test, expect } from "vitest";
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

  test("the Plan step reports drift as a run outcome", () => {
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

describe("TerraformWatchOp on a live root (#2105)", () => {
  const live = (over: Partial<Parameters<typeof TerraformWatchOp>[0]> = {}): OpConfig =>
    props({ name: "estate-watch", root: "estate", live: true, ...over });

  test("the Plan step is choudoufuLivePlan, and Init is unchanged", () => {
    const op = live();
    expect(phaseNames(op)).toEqual(["Init", "Plan"]);
    expect(steps(op).map((s) => s.fn)).toEqual(["terraformInit", "choudoufuLivePlan"]);
  });

  test("one live read publishes Drift, Unowned and Adoptable", () => {
    const plan = live().phases[1].steps[0] as ActivityStep;
    expect(plan.id).toBe("plan");
    // `drift` off `-detailed-exitcode`, `unowned`/`adoptable` off the same
    // run's #788 document: three answers, one estate-wide sweep.
    expect(plan.outcomeAttribute).toEqual([
      { name: "Drift", from: "drift" },
      { name: "Unowned", from: "unowned" },
      { name: "Adoptable", from: "adoptable" },
    ]);
  });

  test("the Op is marked live, and no plan file is named anywhere", () => {
    const op = live();
    expect(op.labels).toMatchObject({ TerraformMode: "live" });
    expect(JSON.stringify(op)).not.toContain("chant.tfplan");
  });

  test("planFile on a live root is refused at build time, quoting choudoufu", () => {
    expect(() => live({ planFile: "estate.tfplan" })).toThrow(/planFile is refused on a live root/);
  });

  test("estate off a live root is refused: there is no live plan to name one for", () => {
    expect(() => props({ name: "app-watch", root: "app", estate: "prod" })).toThrow(/not on a live root/);
  });

  test("an explicit estate rides the Plan step", () => {
    const plan = live({ estate: "prod-networking" }).phases[1].steps[0] as ActivityStep;
    expect(plan.args?.estate).toBe("prod-networking");
  });

  test("a stock root is untouched: still terraformPlan, still one Drift attribute", () => {
    const plan = props({ name: "app-watch", root: "app" }).phases[1].steps[0] as ActivityStep;
    expect(plan.fn).toBe("terraformPlan");
    expect(plan.outcomeAttribute).toEqual({ name: "Drift", from: "changed" });
  });

  for (const mode of ["issue", "pull-request"] as const) {
    test(`${mode}: the body is the plan text plus the adoption ledger, as one field`, () => {
      const op = live({ findingMode: mode });
      expect(phaseNames(op)).toEqual(["Init", "Plan", "Report"]);
      const report = op.phases[2].steps[0] as ActivityStep;
      expect(report.fn).toBe("reconcilePr");
      expect(isStepOutputRef(report.args?.body)).toBe(true);
      expect(report.args?.body).toMatchObject({ step: "plan", path: "finding" });
    });

    test(`${mode}: no reference to the live-plan document reaches the body`, () => {
      // On a live root the JSON is choudoufu's bound/omissions/unowned
      // document: live identities and tag values for every resource the
      // estate touched. Same rule as the stock plan's JSON, same test.
      const op = live({ findingMode: mode });
      const report = op.phases[2].steps[0] as ActivityStep;
      const paths = collectStepOutputRefs(report.args).map((r) => r.path);
      expect(paths).toEqual(["finding"]);
      expect(paths).not.toContain("json");
      expect(JSON.stringify(report.args)).not.toContain("json");
    });
  }

  test("the whole live Op references exactly one field of the plan", () => {
    const op = live({ findingMode: "issue" });
    const refs = op.phases.flatMap((p) => p.steps.filter(isActivity)).flatMap((s) => collectStepOutputRefs(s.args));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ step: "plan", path: "finding" });
  });
});

describe("TerraformWatchOp schedule (#2087, #2120)", () => {
  test("omitting `schedule` leaves the Op with no cadence", () => {
    const { op } = TerraformWatchOp({ name: "app-watch", root: "app" });
    expect((op as unknown as { props: OpConfig }).props).not.toHaveProperty("schedule");
  });

  test("a cron lands on the Op itself", () => {
    const { op } = TerraformWatchOp({
      name: "app-watch",
      root: "app",
      schedule: "0 6 * * *",
    });
    expect((op as unknown as { props: OpConfig }).props.schedule).toEqual({
      cron: "0 6 * * *",
      overlap: "skip",
    });
  });
});

/**
 * The `live` flag against the root it names (#2216). Best-effort: the mode
 * resolves from a `chant.config.json` only, so these projects are written in
 * that format. TF028 (`../lint/post-synth/tf028.ts`) is what reports the same
 * mismatch on a `chant.config.ts` project, where the mode does not resolve
 * here at all.
 */
describe("TerraformWatchOp cross-checks live against the root's mode (#2216)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const LIVE_ROOT = [
    "terraform {",
    "  live {",
    '    estate = "prod-estate"',
    "  }",
    "}",
    "",
  ].join("\n");

  /** A project on a `chant.config.json` whose root `estate` is `mainTf`, run on `binary`. */
  function project(binary: string, mainTf: string): string {
    const dir = mkdtempSync(join(tmpdir(), "chant-tf-watch-mode-"));
    dirs.push(dir);
    mkdirSync(join(dir, "estate"), { recursive: true });
    writeFileSync(join(dir, "estate", "main.tf"), mainTf);
    writeFileSync(
      join(dir, "chant.config.json"),
      JSON.stringify({ terraform: { binary, roots: { estate: { dir: "./estate" } } } }),
    );
    return dir;
  }

  test("refuses a live root watched in stock mode, naming the Op and the root", () => {
    const cwd = project("choudoufu", LIVE_ROOT);
    expect(() => TerraformWatchOp({ name: "estate-watch", root: "estate", cwd })).toThrow(
      /TerraformWatchOp "estate-watch": root "estate" runs choudoufu with a declared estate/,
    );
  });

  test("accepts the same root with live: true", () => {
    const cwd = project("choudoufu", LIVE_ROOT);
    expect(() => TerraformWatchOp({ name: "estate-watch", root: "estate", live: true, cwd })).not.toThrow();
  });

  test("refuses live: true on a root that declares no estate", () => {
    const cwd = project("choudoufu", 'resource "null_resource" "first" {}\n');
    expect(() => TerraformWatchOp({ name: "app-watch", root: "estate", live: true, cwd })).toThrow(
      /declares no estate/,
    );
  });

  test("refuses live: true when the binary is not choudoufu, whatever the root declares", () => {
    const cwd = project("terraform", LIVE_ROOT);
    expect(() => TerraformWatchOp({ name: "app-watch", root: "estate", live: true, cwd })).toThrow(
      /declares no estate/,
    );
  });

  test("says nothing when the mode does not resolve: no config to read", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-tf-watch-mode-"));
    dirs.push(dir);
    expect(() => TerraformWatchOp({ name: "app-watch", root: "estate", cwd: dir })).not.toThrow();
    expect(() => TerraformWatchOp({ name: "app-watch", root: "estate", live: true, cwd: dir })).not.toThrow();
  });
});
