/**
 * Renderers for a derived fan-out (#2420) — the printed derivation #2417's
 * proof list asks for and nothing produced.
 *
 * `./driver-output.ts` is the precedent and the shape is deliberately the
 * same: a human renderer that logs to stderr, a JSON renderer that owns
 * stdout and writes nothing else, both over the types the model already
 * returns (`./fan-out.ts`'s `FanOutPlan`, `./fan-out-run.ts`'s
 * `FanOutRunResult`). No new fields are computed here. A renderer that had to
 * derive something to print it would be deriving it twice.
 *
 * ## What gets printed, and why each line is not optional
 *
 * A fan-out that applies the right components without saying why it picked
 * them reads exactly like one that fanned out to everything, which is the
 * failure #2417's precision decision exists to prevent. So:
 *
 * - **the waves**, because the claim is that the order was derived from the
 *   source rather than declared, and a flat list cannot show that
 * - **every component that is not running, with its reason** — `unaffected`,
 *   `indeterminate`, `already-applied`, `blocked` — because "absent from the
 *   list" and "deliberately held back" look identical otherwise
 * - **`indeterminate` on its own line**, because it is the third outcome and a
 *   two-state render would quietly drop it into one of the other two
 * - **`seeds`**, because those values are being taken on trust from a run that
 *   happened earlier and somewhere else
 * - **the `digest`, verbatim and unabbreviated**, because it is the string
 *   `chant approve --plan` takes. Truncating it for width would make the line
 *   unusable for the one job it has.
 */

import type { FanOutPlan, FanOutSkip } from "./fan-out";
import type { FanOutRunResult } from "./fan-out-run";

type Writer = (line: string) => void;

const stderr: Writer = (line) => process.stderr.write(line + "\n");
const stdout: Writer = (line) => process.stdout.write(line + "\n");

/** The gate one fan-out is bound to, when the invocation asked for one. */
export interface FanOutGateRef {
  op: string;
  gate: string;
}

export interface FanOutRenderOptions {
  write?: Writer;
  /** Present when a gate covers the set, so the render can print the exact approve line. */
  gate?: FanOutGateRef;
}

/** `unaffected` → `unaffected`; `blocked` also names the failure it was reached from. */
function reasonOf(skip: FanOutSkip): string {
  return skip.reason === "blocked" && skip.blockedBy
    ? `blocked by "${skip.blockedBy}"`
    : skip.reason;
}

/** Longest component name in `skips`, for a column that lines up without padding every render. */
function widestName(skips: readonly FanOutSkip[]): number {
  return skips.reduce((w, s) => Math.max(w, s.component.length), 0);
}

/**
 * The derivation itself: the waves, what is not running and why, what is
 * seeded, and the digest an approval binds to.
 *
 * This is the whole output of a plan-only invocation and the header of a run,
 * so it is one function rather than two nearly identical ones.
 */
export function renderFanOutPlan(plan: FanOutPlan, options: FanOutRenderOptions = {}): void {
  const write = options.write ?? stderr;

  // Three outcomes, never two (#2417). The counts come first because they are
  // the claim the rest of the block substantiates.
  const unaffected = plan.skipped.filter((s) => s.reason === "unaffected").length;
  const held = plan.skipped.filter((s) => s.reason === "already-applied" || s.reason === "blocked").length;
  write(
    `fan-out: ${plan.order.length} selected, ${unaffected} unaffected, ` +
      `${plan.indeterminate.length} indeterminate` +
      (held > 0 ? `, ${held} held back` : ""),
  );

  if (plan.order.length === 0) {
    write("  nothing to run");
  } else {
    for (const [index, wave] of plan.waves.entries()) {
      write(`  wave ${index + 1}: ${wave.join(", ")}`);
    }
  }

  if (plan.seeds.length > 0) {
    write(`  seeded from an earlier run: ${plan.seeds.join(", ")}`);
  }

  if (plan.skipped.length > 0) {
    write(`  not running (${plan.skipped.length}):`);
    const width = widestName(plan.skipped);
    for (const skip of plan.skipped) {
      write(`    ${skip.component.padEnd(width)}  ${reasonOf(skip)}`);
    }
  }

  if (plan.indeterminate.length > 0) {
    // Named separately from the `indeterminate` rows above because the two say
    // different things: those rows are "not selected", this line is "a source
    // diff could not judge it and the walk never reached it either", which is
    // the one outcome nobody should read as a decision.
    write(
      `  a source diff cannot judge these, and the walk did not reach them: ` +
        plan.indeterminate.join(", "),
    );
  }

  // Verbatim: this is the string `chant approve --plan` takes.
  write(`  plan: ${plan.digest}`);
  if (options.gate) {
    write(`  approve: chant approve ${options.gate.op} ${options.gate.gate} --plan ${plan.digest}`);
  }
}

/**
 * A dispatched fan-out: the derivation that ran, then what it did.
 *
 * `result.plan` is the plan as dispatched, so on a resume this prints the
 * narrowed one, with everything an earlier attempt finished listed as
 * `already-applied`. That is the point of printing the plan off the result
 * rather than off whatever the caller derived.
 */
export function renderFanOutHuman(result: FanOutRunResult, options: FanOutRenderOptions = {}): void {
  const write = options.write ?? stderr;
  renderFanOutPlan(result.plan, { ...options, write });

  if (result.status === "gated") {
    const gate = result.gate;
    write(`gated: nothing ran. ${gate ? `Waiting on "${gate.gate}" on "${gate.op}".` : "Waiting on an approval."}`);
    if (gate?.expiresAt) write(`  expires: ${gate.expiresAt}`);
    return;
  }

  if (result.completed.length > 0) write(`applied: ${result.completed.join(", ")}`);
  if (result.failed.length > 0) write(`failed: ${result.failed.join(", ")}`);
  for (const blocked of result.blocked) {
    write(`  ${blocked.component}: ${reasonOf(blocked)}, so it never ran`);
  }

  const counts =
    `${result.completed.length} applied, ${result.failed.length} failed, ` +
    `${result.blocked.length} blocked`;
  write(result.status === "ok" ? `fan-out completed: ${counts}` : `fan-out failed: ${counts}`);
}

/**
 * The plan or the run result as JSON on stdout, and nothing else on stdout.
 *
 * One function for both because the run result carries the plan under `plan`,
 * so a consumer discriminates on that key rather than on a flag it was told
 * about out of band.
 */
export function renderFanOutJson(payload: FanOutPlan | FanOutRunResult, write: Writer = stdout): void {
  write(JSON.stringify(payload));
}
