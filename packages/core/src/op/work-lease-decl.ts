/**
 * The rules an Op's `workLease` and `changesCheckout` declaration keeps
 * (#2748), with no imports beyond the Op model, so `Op()` and
 * `declareSteward` can check them without loading the lease machinery in
 * `./work-lease-run.ts`.
 */

import { isStepOutputRef } from "./step-output-ref";
import { parseDuration } from "./duration";
import { WORK_LEASE_STEP_ID, type OpConfig, type PhaseDefinition } from "./types";

/** A work item id a lease can be keyed by: the same pattern as `WORK_ITEM_ID_PATTERN` in `../lifecycle/work-lease.ts`. */
export const WORK_LEASE_ITEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The ids of the activity steps in an Op's main phases, in order. */
function mainStepIds(phases: readonly PhaseDefinition[]): string[] {
  const ids: string[] = [];
  for (const phase of phases) {
    for (const step of phase.steps) if (step.kind === "activity" && step.id) ids.push(step.id);
  }
  return ids;
}

/**
 * What is wrong with an Op's `workLease` and `changesCheckout`, or an empty
 * list. The executor refuses to start a run with any of these, and
 * `declareSteward` refuses to list the Op.
 */
export function workLeaseProblems(config: Pick<OpConfig, "name" | "phases" | "workLease" | "changesCheckout">): string[] {
  const problems: string[] = [];
  const spec = config.workLease;
  const name = config.name;
  if (config.changesCheckout && !spec) {
    problems.push(
      `Op "${name}" changes the checkout but declares no workLease. A change to the checkout happens under a work item's lease, ` +
        `on a branch of its own: declare workLease on the Op.`,
    );
  }
  if (!spec) return problems;
  const ids = mainStepIds(config.phases ?? []);
  if (ids.includes(WORK_LEASE_STEP_ID)) {
    problems.push(`Op "${name}": step id "${WORK_LEASE_STEP_ID}" is reserved for the run's work lease; rename the step`);
  }
  const checkId = (id: unknown) => {
    if (typeof id !== "string" || !WORK_LEASE_ITEM_PATTERN.test(id) || id.includes("..")) {
      problems.push(`Op "${name}": workLease.item ${JSON.stringify(id)} can't key a work lease (letters, digits, ".", "_" and "-")`);
    }
  };
  const item = spec.item;
  if (isStepOutputRef(item)) {
    if (!ids.includes(item.step)) {
      problems.push(`Op "${name}": workLease.item references step "${item.step}", which no activity step in the Op's phases declares`);
    }
  } else if (Array.isArray(item)) {
    if (item.length === 0) problems.push(`Op "${name}": workLease.item is an empty list`);
    item.forEach(checkId);
  } else if (item !== undefined) {
    checkId(item);
  }
  if (spec.ttl !== undefined) {
    try {
      if (parseDuration(spec.ttl) < 3_000) problems.push(`Op "${name}": workLease.ttl "${spec.ttl}" is shorter than 3s`);
    } catch (err) {
      problems.push(`Op "${name}": workLease.ttl: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (spec.outcome !== undefined && !isStepOutputRef(spec.outcome)) {
    problems.push(`Op "${name}": workLease.outcome is a reference to a step's output`);
  }
  if (spec.kind !== undefined && (typeof spec.kind !== "string" || spec.kind.trim() === "")) {
    problems.push(`Op "${name}": workLease.kind names a work kind file`);
  }
  return problems;
}

/** Whether a run of this Op has to be told its work item (`--work <id>`). */
export function workLeaseNeedsRunItem(config: Pick<OpConfig, "workLease">): boolean {
  return config.workLease !== undefined && config.workLease.item === undefined;
}

