/**
 * The e2e harness's contracts (chant#4587) and their validators: the fan-out
 * demo's demo-step/v1 and demo-cycle/v1 (#4085 section 3, #4092, moved here
 * from examples/fan-out-estate/demo/schemas), and the harness's own
 * e2e-scenario/v1, e2e-claim-row/v1 and e2e-claims/v1. The schemas are the
 * source of truth; the types follow them.
 */
import { createRequire } from "node:module";
import { loadAjv2020 } from "../../workspace/ajv2020";

const require = createRequire(import.meta.url);
const stepSchema = require("./demo-step.schema.json") as object;
const cycleSchema = require("./demo-cycle.schema.json") as object;
const scenarioSchema = require("./e2e-scenario.schema.json") as object;
const claimRowSchema = require("./e2e-claim-row.schema.json") as object;
const claimsSchema = require("./e2e-claims.schema.json") as object;

export const DEMO_STEP_SCHEMA = "https://intentius.io/chant/schemas/demo/demo-step/v1/demo-step.schema.json";
export const DEMO_CYCLE_SCHEMA = "https://intentius.io/chant/schemas/demo/demo-cycle/v1/demo-cycle.schema.json";
export const E2E_SCENARIO_SCHEMA = "https://intentius.io/chant/schemas/e2e-harness/e2e-scenario/v1/e2e-scenario.schema.json";
export const E2E_CLAIM_ROW_SCHEMA = "https://intentius.io/chant/schemas/e2e-harness/e2e-claim-row/v1/e2e-claim-row.schema.json";
export const E2E_CLAIMS_SCHEMA = "https://intentius.io/chant/schemas/e2e-harness/e2e-claims/v1/e2e-claims.schema.json";

// ── demo-step/v1 and demo-cycle/v1 ────────────────────────────────────

export const DEMO_STEPS = [
  "pull-request",
  "planned",
  "waiting",
  "approved",
  "merged",
  "applying",
  "failed",
  "resumed",
  "applied",
  "reset",
  "stalled",
] as const;

export type DemoStepName = (typeof DEMO_STEPS)[number];

export interface DemoChapter {
  n: number;
  of: number;
  headline: string;
  short: string;
}

/** Keys are reportKey(pr, commit) from pr-report-url.ts, below `url`. */
export interface DemoReports {
  url: string;
  plan?: string;
  apply?: string;
}

/** A call-out a viewer may show as a modal at the step. */
export interface DemoHighlight {
  title: string;
  body: string;
}

export interface DemoStep {
  $schema: string;
  contract: 1;
  demo: string;
  cycle: number;
  step: DemoStepName;
  repo?: string;
  scenario?: string;
  name?: string;
  title?: string;
  label?: string;
  highlight?: DemoHighlight | null;
  chapter?: DemoChapter | null;
  started_at?: string;
  at?: string;
  next?: { action?: string; from?: string; at?: string };
  pull?: number | null;
  commit?: string;
  reports?: DemoReports;
  cycle_reports?: DemoCycleReport[];
  about?: { changes?: string; watch?: string; shows?: string };
}

export interface DemoCycleStep extends Omit<DemoStep, "$schema" | "contract" | "demo" | "cycle" | "at"> {
  $schema?: string;
  contract?: 1;
  demo?: string;
  cycle?: number;
  at: string;
}

export interface DemoCycleReport {
  stage: "plan" | "apply";
  pr: number;
  commit: string;
  key: string;
}

export interface DemoCycle {
  $schema: string;
  contract: 1;
  demo: string;
  cycle: number;
  repo?: string;
  started?: string;
  ended?: string;
  steps: DemoCycleStep[];
  reports?: DemoCycleReport[];
}

// ── e2e-scenario/v1 ───────────────────────────────────────────────────

export const SCENARIO_STEP_KINDS = ["open", "open-concurrent", "await-pull", "plan", "approve", "merge", "comment", "apply", "out-of-band", "kill-job"] as const;
export type ScenarioStepKind = (typeof SCENARIO_STEP_KINDS)[number];

/** One thing a step must show. Exactly one key is set. */
export type ScenarioOutcome =
  | { report: { status?: string; components?: Record<string, string>; only?: boolean } }
  | { ledger: { op: string; status?: "ok" | "fail" | "gated" | "waiting"; count?: number } }
  | { gated: { op: string; status?: "gated" | "ok" | "failed"; count?: number } }
  | { comment: string }
  | { pull: { title?: string; files?: string[]; only?: boolean } }
  | { issue: { title: string; open?: boolean } }
  | { exit: number };

interface StepBase {
  id: string;
  label?: string;
  expect?: ScenarioOutcome[];
}

export type ScenarioStep =
  | (StepBase & { do: "open" | "open-concurrent"; branch: string; overlay: string; title: string; body?: string })
  | (StepBase & { do: "await-pull"; branch: string; title?: string })
  | (StepBase & { do: "plan" | "approve" | "merge"; pull: string })
  | (StepBase & { do: "comment"; pull: string; body: string; as?: "author" | "reviewer" | "admin" })
  | (StepBase & { do: "apply"; merge: string })
  | (StepBase & { do: "out-of-band"; command: string[] })
  | (StepBase & { do: "kill-job"; match?: string });

export interface Scenario {
  $schema: string;
  contract: 1;
  id: string;
  product: string;
  claim: string;
  title?: string;
  tree: { base: string; overlays?: string };
  env?: string;
  reportUrl: string;
  limits?: Partial<Record<ScenarioStepKind, number>>;
  steps: ScenarioStep[];
  break: { env: { BREAK: "1" } & Record<string, string>; overlay?: string; note?: string };
}

// ── e2e-claim-row/v1 and e2e-claims/v1 ────────────────────────────────

export type PlainVerdict = "pass" | "fail";
export type BreakVerdict = "caught" | "missed" | "stalled";

export interface ClaimRow {
  $schema: string;
  contract: 1;
  product: string;
  productCommit: string;
  scenario: string;
  claim: string;
  engine: { binary: string; version: string };
  floci: string;
  chant?: string;
  date: string;
  plain: PlainVerdict;
  break: BreakVerdict;
  safeRun: "CLEAN";
  runUrl?: string;
}

export interface ClaimsDoc {
  $schema: string;
  contract: 1;
  product: string;
  rows: ClaimRow[];
}

// ── validators ────────────────────────────────────────────────────────

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type ValidateFn = ((data: unknown) => boolean) & {
  errors?: { instancePath: string; message?: string }[] | null;
};

interface AjvInstance {
  addSchema(schema: object): unknown;
  getSchema(id: string): unknown;
}

let ajv: AjvInstance | undefined;

function validatorFor(id: string): ValidateFn {
  if (!ajv) {
    const Ajv = loadAjv2020();
    const made = new Ajv({ allErrors: true, strict: true }) as unknown as AjvInstance;
    for (const s of [stepSchema, cycleSchema, scenarioSchema, claimRowSchema, claimsSchema]) made.addSchema(s);
    ajv = made;
  }
  const fn = ajv.getSchema(id) as ValidateFn | undefined;
  if (!fn) throw new Error(`no schema ${id}`);
  return fn;
}

function check<T>(id: string, data: unknown): Validation<T> {
  const fn = validatorFor(id);
  if (fn(data)) return { ok: true, value: data as T };
  const errors = (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
  return { ok: false, errors };
}

export const validateDemoStep = (data: unknown): Validation<DemoStep> => check(DEMO_STEP_SCHEMA, data);
export const validateDemoCycle = (data: unknown): Validation<DemoCycle> => check(DEMO_CYCLE_SCHEMA, data);
export const validateScenario = (data: unknown): Validation<Scenario> => check(E2E_SCENARIO_SCHEMA, data);
export const validateClaimRow = (data: unknown): Validation<ClaimRow> => check(E2E_CLAIM_ROW_SCHEMA, data);
export const validateClaims = (data: unknown): Validation<ClaimsDoc> => check(E2E_CLAIMS_SCHEMA, data);
