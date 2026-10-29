/**
 * The harness's contracts (chant#4587): e2e-scenario/v1 and its lint, which
 * refuses a scenario with no claim id or no BREAK arm, and e2e-claim-row/v1
 * and e2e-claims/v1. demo-step/v1 and demo-cycle/v1 keep their own tests in
 * examples/fan-out-estate/demo/schemas/index.test.ts.
 */
import { describe, expect, test } from "vitest";
import { lintScenario } from "./scenario";
import {
  E2E_CLAIMS_SCHEMA,
  E2E_CLAIM_ROW_SCHEMA,
  E2E_SCENARIO_SCHEMA,
  validateClaimRow,
  validateClaims,
  validateDemoStep,
  validateScenario,
  type ClaimRow,
} from "./schemas/index";
import { FLOCI_DIGEST } from "./pins";

const scenario = (): Record<string, unknown> => ({
  $schema: E2E_SCENARIO_SCHEMA,
  contract: 1,
  id: "tg-estate-overlap",
  product: "terragucci",
  claim: "choudoufu/rows-overlap",
  tree: { base: "trees/estate", overlays: "trees/overlays" },
  reportUrl: "s3://terragucci-e2e/estate/reports",
  steps: [
    { id: "one", do: "open", branch: "e2e/one", overlay: "one", title: "One" },
    { id: "two", do: "open-concurrent", branch: "e2e/two", overlay: "two", title: "Two" },
    { id: "one-plan", do: "plan", pull: "one", expect: [{ report: { status: "planned" } }] },
    { id: "one-merge", do: "merge", pull: "one" },
    { id: "one-apply", do: "apply", merge: "one-merge", expect: [{ report: { status: "applied", components: { a: "applied" }, only: true } }] },
  ],
  break: { env: { BREAK: "1" }, note: "the second apply takes the first's rows" },
});

const at = (findings: { at: string; message: string }[]) => findings.map((f) => f.at);

describe("e2e-scenario/v1 and its lint", () => {
  test("a scenario with a claim, steps that expect something and a BREAK arm lints clean", () => {
    expect(validateScenario(scenario()).ok).toBe(true);
    expect(lintScenario(scenario())).toEqual([]);
  });

  test("refuses a scenario with no claim id", () => {
    const s = scenario();
    delete s.claim;
    expect(lintScenario(s)).toContainEqual({ at: "/claim", message: "the scenario has no claim id, so its run would record a row for nothing" });
    expect(lintScenario({ ...scenario(), claim: " " }).map((f) => f.at)).toContain("/claim");
  });

  test("refuses a scenario with no BREAK arm, or one that does not set BREAK=1", () => {
    const s = scenario();
    delete s.break;
    expect(lintScenario(s)).toContainEqual({ at: "/break", message: "the scenario has no BREAK arm, so nothing shows its outcomes can fail" });
    expect(at(lintScenario({ ...scenario(), break: { env: { BREAK: "0" } } }))).toContain("/break/env/BREAK");
    expect(at(lintScenario({ ...scenario(), break: { overlay: "broken" } }))).toContain("/break/env/BREAK");
  });

  test("refuses steps that name a pull request or a merge no earlier step made", () => {
    const s = scenario();
    const steps = s.steps as Array<Record<string, unknown>>;
    steps[2] = { id: "one-plan", do: "plan", pull: "nobody", expect: [{ report: { status: "planned" } }] };
    steps[4] = { id: "one-apply", do: "apply", merge: "one", expect: [{ exit: 0 }] };
    const findings = lintScenario(s);
    expect(findings).toContainEqual({ at: "/steps/2/pull", message: "plan names nobody, which is not an earlier open or await-pull step" });
    expect(findings).toContainEqual({ at: "/steps/4/merge", message: "apply names one, which is not an earlier merge step" });
    expect(findings).toContainEqual({ at: "/steps/4/expect/0", message: "an exit outcome belongs on an out-of-band step" });
  });

  test("refuses a scenario that checks nothing, a repeated id and a lone open-concurrent", () => {
    const s = scenario();
    s.steps = [
      { id: "x", do: "open-concurrent", branch: "x", overlay: "x", title: "X" },
      { id: "x", do: "kill-job" },
    ];
    expect(lintScenario(s)).toEqual([
      { at: "/steps/0/do", message: "open-concurrent opens beside the step before it, which must be an open" },
      { at: "/steps/1/id", message: "step id x is used twice" },
      { at: "/steps", message: "no step expects anything, so the plain run would pass and the BREAK run could never be caught" },
    ]);
  });

  test("the schema refuses an unknown step, a step missing its fields and an outcome with two keys", () => {
    for (const bad of [
      { id: "s", do: "deploy" },
      { id: "s", do: "open", branch: "b", title: "T" },
      { id: "s", do: "plan", pull: "one", expect: [{ exit: 0, comment: "x" }] },
    ]) {
      const s = scenario();
      (s.steps as unknown[]).push(bad);
      expect(validateScenario(s).ok, JSON.stringify(bad)).toBe(false);
      expect(lintScenario(s).length).toBeGreaterThan(0);
    }
  });
});

describe("e2e-scenario/v1 steps for a pull request a product opens (chant#4650)", () => {
  const product = (steps: unknown[]): Record<string, unknown> => ({ ...scenario(), steps });
  const request = { id: "request", do: "out-of-band", command: ["terragucci", "request"], expect: [{ exit: 0 }] };

  test("await-pull, comment and the pull and gated outcomes are in the schema", () => {
    const s = product([
      request,
      { id: "pr", do: "await-pull", branch: "request/bucket/orders", title: "orders", expect: [{ pull: { title: "orders", files: ["apps/orders/main.tf"], only: true } }] },
      { id: "pr-plan", do: "plan", pull: "pr", expect: [{ report: { status: "planned" } }] },
      { id: "invoke", do: "comment", pull: "pr", body: "/terragucci action orders rotate", as: "reviewer", expect: [{ gated: { op: "tf-action", status: "gated", count: 1 } }] },
    ]);
    expect(validateScenario(s)).toMatchObject({ ok: true });
    expect(lintScenario({ ...s, limits: { "await-pull": 600, comment: 30 } })).toEqual([]);
  });

  test("a plan naming an await-pull step lints clean, and one naming an unknown id has one finding naming it", () => {
    const steps = (pull: string) => [request, { id: "pr", do: "await-pull", branch: "request/bucket/orders" }, { id: "pr-plan", do: "plan", pull, expect: [{ report: { status: "planned" } }] }];
    expect(lintScenario(product(steps("pr")))).toEqual([]);
    expect(lintScenario(product(steps("nobody")))).toEqual([{ at: "/steps/2/pull", message: "plan names nobody, which is not an earlier open or await-pull step" }]);
  });

  test("a comment step names an earlier pull request, and a pull outcome belongs on a step with one", () => {
    expect(lintScenario(product([request, { id: "c", do: "comment", pull: "later", body: "hi" }]))).toEqual([{ at: "/steps/1/pull", message: "comment names later, which is not an earlier open or await-pull step" }]);
    expect(lintScenario(product([{ ...request, expect: [{ pull: { only: true } }] }]))).toEqual([{ at: "/steps/0/expect/0", message: "a pull outcome belongs on a step with a pull request" }]);
  });

  test("the schema refuses an await-pull with no branch, a comment with no pull or body, and unknown fields in the outcomes", () => {
    for (const bad of [
      { id: "s", do: "await-pull", title: "T" },
      { id: "s", do: "comment", pull: "one" },
      { id: "s", do: "comment", body: "hi" },
      { id: "s", do: "comment", pull: "one", body: "hi", as: "stranger" },
      { id: "s", do: "plan", pull: "one", expect: [{ pull: { branch: "x" } }] },
      { id: "s", do: "plan", pull: "one", expect: [{ gated: { status: "ok" } }] },
      { id: "s", do: "plan", pull: "one", expect: [{ gated: { op: "tf-action", status: "applied" } }] },
    ]) {
      const s = scenario();
      (s.steps as unknown[]).push(bad);
      expect(validateScenario(s).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

const row = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  $schema: E2E_CLAIM_ROW_SCHEMA,
  contract: 1,
  product: "terragucci",
  productCommit: "e962b2c0000000000000000000000000000000aa",
  scenario: "tg-estate-overlap",
  claim: "choudoufu/rows-overlap",
  engine: { binary: "choudoufu", version: "0.31.0" },
  floci: FLOCI_DIGEST,
  date: "2026-10-28",
  plain: "pass",
  break: "caught",
  safeRun: "CLEAN",
  ...over,
});

describe("e2e-claim-row/v1 and e2e-claims/v1", () => {
  test("a row carries the product and its commit, the engine binary and version, the floci digest, the date and both verdicts", () => {
    expect(validateClaimRow(row())).toEqual({ ok: true, value: row() });
    const required = (JSON.parse(JSON.stringify(row())) as Record<string, unknown>);
    for (const k of ["product", "productCommit", "engine", "floci", "date", "plain", "break", "safeRun"]) {
      const r = { ...required };
      delete r[k];
      expect(validateClaimRow(r).ok, k).toBe(false);
    }
  });

  test("refuses a short commit, a tag in place of a digest, a verdict it does not know and a scan that was not CLEAN", () => {
    expect(validateClaimRow(row({ productCommit: "e962b2c" })).ok).toBe(false);
    expect(validateClaimRow(row({ floci: "63d8f1ed" })).ok).toBe(false);
    expect(validateClaimRow({ ...row(), plain: "ok" }).ok).toBe(false);
    expect(validateClaimRow({ ...row(), safeRun: "REAL-CLOUD" }).ok).toBe(false);
    expect(validateClaimRow({ ...row(), date: "28 Oct 2026" }).ok).toBe(false);
  });

  test("a product's claims are its rows", () => {
    expect(validateClaims({ $schema: E2E_CLAIMS_SCHEMA, contract: 1, product: "terragucci", rows: [row()] }).ok).toBe(true);
    expect(validateClaims({ $schema: E2E_CLAIMS_SCHEMA, contract: 1, product: "terragucci", rows: [{ ...row(), break: "maybe" }] }).ok).toBe(false);
  });

  test("demo-step/v1 validates from the harness as it did from the demo", () => {
    const step = { $schema: "https://intentius.io/chant/schemas/demo/demo-step/v1/demo-step.schema.json", contract: 1, demo: "fan-out-estate", cycle: 1, step: "planned" };
    expect(validateDemoStep(step).ok).toBe(true);
    expect(validateDemoStep({ ...step, step: "exploded" }).ok).toBe(false);
  });
});
