/**
 * Types and validators for the fan-out demo's two contracts, demo-step/v1 and
 * demo-cycle/v1 (#4085 section 3, #4092). The driver validates every write
 * against them. The schemas are the source of truth; the types follow them.
 */
import { createRequire } from "node:module";
import { loadAjv2020 } from "../../../../packages/core/src/workspace/ajv2020.js";

const require = createRequire(import.meta.url);
const stepSchema = require("./demo-step.schema.json") as object;
const cycleSchema = require("./demo-cycle.schema.json") as object;

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

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type ValidateFn = ((data: unknown) => boolean) & {
  errors?: { instancePath: string; message?: string }[] | null;
};

function compile(schema: object): ValidateFn {
  const Ajv = loadAjv2020();
  return new Ajv({ allErrors: true, strict: true }).compile(schema) as ValidateFn;
}

let stepValidate: ValidateFn | undefined;
let cycleValidate: ValidateFn | undefined;

function run<T>(fn: ValidateFn, data: unknown): Validation<T> {
  if (fn(data)) return { ok: true, value: data as T };
  const errors = (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
  return { ok: false, errors };
}

export function validateDemoStep(data: unknown): Validation<DemoStep> {
  stepValidate ??= compile(stepSchema);
  return run<DemoStep>(stepValidate, data);
}

export function validateDemoCycle(data: unknown): Validation<DemoCycle> {
  cycleValidate ??= compile(cycleSchema);
  return run<DemoCycle>(cycleValidate, data);
}
