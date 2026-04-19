/**
 * Op type definitions — the data model for a named, phased Temporal workflow.
 *
 * These types are intentionally free of Temporal SDK imports so they can live
 * in core without pulling in @temporalio/* as a dependency.
 */

export interface OpConfig {
  /** Kebab-case identifier. Used as the workflow function name (camelCase) and output directory name. */
  name: string;
  /** Human-readable description shown in `chant run list` and deployment reports. */
  overview: string;
  /** Temporal task queue. Defaults to `name`. */
  taskQueue?: string;
  /** Temporal namespace. Defaults to chant.config.ts defaultProfile's namespace. */
  namespace?: string;
  /** Ordered list of execution phases. */
  phases: PhaseDefinition[];
  /** Other Op names that must be complete before this Op can run. */
  depends?: string[];
  /** Compensation phases executed on terminal failure (run in reverse order). */
  onFailure?: PhaseDefinition[];
  /** Search attributes to upsert at workflow start. */
  searchAttributes?: Record<string, string>;
}

export interface PhaseDefinition {
  /** Display name shown in progress output and Temporal UI. */
  name: string;
  /** Ordered steps within the phase. */
  steps: StepDefinition[];
  /** Run all steps concurrently via Promise.all. Default: false. */
  parallel?: boolean;
}

export type StepDefinition = ActivityStep | GateStep;

export interface ActivityStep {
  kind: "activity";
  /** Name of the exported activity function in the pre-built activity library. */
  fn: string;
  /** Arguments passed to the activity function. */
  args?: Record<string, unknown>;
  /**
   * Key from TEMPORAL_ACTIVITY_PROFILES controlling timeout + retry.
   * Default: "fastIdempotent"
   */
  profile?: "fastIdempotent" | "longInfra" | "k8sWait" | "humanGate";
}

export interface GateStep {
  kind: "gate";
  /** Signal name. The generated workflow waits for this signal before continuing. */
  signalName: string;
  /** Temporal duration string. Default: "48h". */
  timeout?: string;
  /** Human-readable description of the action required to unblock this gate. */
  description?: string;
}

