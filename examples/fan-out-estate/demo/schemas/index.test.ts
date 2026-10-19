import { describe, expect, test } from "vitest";
import { reportKey } from "../../../../packages/core/src/pr-report-url.js";
import { DEMO_STEPS, validateDemoCycle, validateDemoStep } from "./index.js";

const STEP_ID = "https://intentius.io/chant/schemas/demo/demo-step/v1/demo-step.schema.json";
const CYCLE_ID = "https://intentius.io/chant/schemas/demo/demo-cycle/v1/demo-cycle.schema.json";
const head = "a".repeat(40);
const merge = "b".repeat(40);

const chapter = (n: number, short: string) => ({ n, of: 4, headline: `${short}, in full`, short });

const step = (over: Record<string, unknown> = {}) => ({
  $schema: STEP_ID,
  contract: 1,
  demo: "fan-out-estate",
  repo: "chant-demo/fan-out-estate",
  cycle: 12,
  scenario: "fan-out",
  name: "fifteen stacks",
  title: "A broken stack shouldn't stall the whole rollout",
  step: "planned",
  label: "15 stacks in 3 waves",
  chapter: chapter(1, "the change"),
  started_at: "2026-10-19T10:00:00Z",
  at: "2026-10-19T10:00:30Z",
  next: { action: "approve", from: "2026-10-19T10:00:30Z", at: "2026-10-19T10:00:42Z" },
  pull: 41,
  commit: head,
  reports: { url: "s3://chant-demo/fan-out-estate/reports", plan: reportKey(41, head), apply: reportKey(41, merge) },
  about: { changes: "a", watch: "b", shows: "c" },
  ...over,
});

describe("demo-step/v1", () => {
  test.each(DEMO_STEPS)("accepts step %s", (name) => {
    const r = validateDemoStep(step({ step: name }));
    expect(r.ok).toBe(true);
  });

  test("accepts the failed step with its chapter", () => {
    const r = validateDemoStep(step({ step: "failed", chapter: chapter(2, "cluster-a breaks") }));
    expect(r.ok).toBe(true);
  });

  test("accepts a stall with chapter null", () => {
    expect(validateDemoStep(step({ step: "stalled", chapter: null })).ok).toBe(true);
  });

  test("accepts the minimal record and unknown extra fields", () => {
    expect(validateDemoStep({ $schema: STEP_ID, contract: 1, demo: "fan-out-estate", cycle: 0, step: "reset", later: 1 }).ok).toBe(true);
  });

  test("rejects an unknown step", () => {
    expect(validateDemoStep(step({ step: "exploded" })).ok).toBe(false);
  });

  test("rejects a bad chapter", () => {
    expect(validateDemoStep(step({ chapter: { n: 0, of: 4, headline: "x" } })).ok).toBe(false);
    expect(validateDemoStep(step({ chapter: "one" })).ok).toBe(false);
  });

  test("rejects a missing or wrong contract", () => {
    const { contract: _c, ...rest } = step();
    const r = validateDemoStep(rest);
    expect(r.ok).toBe(false);
    expect(validateDemoStep(step({ contract: 2 })).ok).toBe(false);
  });

  test("rejects reports without a url or with a key that is not pr/commit", () => {
    expect(validateDemoStep(step({ reports: { plan: reportKey(41, head) } })).ok).toBe(false);
    expect(validateDemoStep(step({ reports: { url: "s3://b/r", plan: "41" } })).ok).toBe(false);
  });

  test("takes an s3:// or https:// report url and refuses any other", () => {
    expect(validateDemoStep(step({ reports: { url: "https://demo.example/reports" } })).ok).toBe(true);
    expect(validateDemoStep(step({ reports: { url: "file:///tmp/reports" } })).ok).toBe(false);
    expect(validateDemoStep(step({ reports: { url: "reports/" } })).ok).toBe(false);
  });

  test("carries the cycle's report keys so far, in run order", () => {
    const fix = "c".repeat(40);
    const cycle_reports = [
      { stage: "plan", pr: 41, commit: head, key: reportKey(41, head) },
      { stage: "apply", pr: 41, commit: merge, key: reportKey(41, merge) },
      { stage: "plan", pr: 42, commit: fix, key: reportKey(42, fix) },
    ];
    expect(validateDemoStep(step({ step: "applying", pull: 42, cycle_reports })).ok).toBe(true);
    expect(validateDemoStep(step({ cycle_reports: [{ stage: "deploy", pr: 41, commit: head, key: reportKey(41, head) }] })).ok).toBe(false);
  });
});

describe("demo-cycle/v1", () => {
  const cycle = (over: Record<string, unknown> = {}) => ({
    $schema: CYCLE_ID,
    contract: 1,
    demo: "fan-out-estate",
    repo: "chant-demo/fan-out-estate",
    cycle: 12,
    started: "2026-10-19T10:00:00Z",
    ended: "2026-10-19T10:03:00Z",
    steps: DEMO_STEPS.filter((s) => s !== "stalled").map((s) => step({ step: s })),
    reports: [
      { stage: "plan", pr: 41, commit: head, key: reportKey(41, head) },
      { stage: "apply", pr: 41, commit: merge, key: reportKey(41, merge) },
    ],
    ...over,
  });

  test("accepts a full cycle", () => {
    const r = validateDemoCycle(cycle());
    expect(r.ok, r.ok ? "" : r.errors.join("; ")).toBe(true);
  });

  test("rejects a step without at, an unknown step, a bad report and a missing contract", () => {
    const { at: _at, ...noAt } = step();
    expect(validateDemoCycle(cycle({ steps: [noAt] })).ok).toBe(false);
    expect(validateDemoCycle(cycle({ steps: [step({ step: "exploded" })] })).ok).toBe(false);
    expect(validateDemoCycle(cycle({ reports: [{ stage: "deploy", pr: 41, commit: head, key: "x" }] })).ok).toBe(false);
    const { contract: _c, ...rest } = cycle();
    expect(validateDemoCycle(rest).ok).toBe(false);
  });
});
