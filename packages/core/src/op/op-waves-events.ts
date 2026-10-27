/**
 * Run events for one `chant run wave` job (#4555), on the run-event contract
 * (../run-event.ts), and its trace through chant's OTLP exporter (../otlp.ts).
 *
 * The job is an Op run (`kind: "op"`, named for the spec). Each wave it
 * walks is a phase `wave-<k>`, as its run record names it (#4551), and each
 * run target is a step of that phase. A target's `step-start` and
 * `step-settle` are written as its apply starts and ends, so a reader
 * following the stream sees each root or stack as it applies. When the job
 * ends, the targets it never applied (moved, blocked, waiting, or planned
 * only) settle as `skipped`, a job that waits at a gate writes
 * `gate-waiting` on a `gate:<name>` step of its last phase, and the phases
 * and the run settle with the run record's verdict. The stream and the
 * record therefore say the same thing.
 *
 * Under the trace, each target's span carries what its capability knew
 * (`Capability.traceFacts`): engine facts as attributes, and a child span per
 * resource the engine timed.
 */

import type { RunEventBody, RunEventSettleStatus } from "../run-event";
import type { RunEventSink } from "../run-event-stream";
import type { CapabilityTraceFacts, RunEventTrace } from "../otlp";
import type { OpRunRecordInput } from "./runtime";

/** How one target's apply settled, as the step says it. */
export type OpWaveTargetSettle = "ok" | "failed" | "skipped";

/** One job's stream: the emitter, and the trace built from it when the exporter is on. */
export class OpWaveRunEvents {
  private readonly phases: string[] = [];
  private readonly settled = new Set<string>();

  constructor(
    private readonly sink: RunEventSink,
    readonly trace?: RunEventTrace,
  ) {}

  private emit(body: RunEventBody): void {
    try {
      this.sink(body);
    } catch {
      // A reader that fails never changes the job.
    }
  }

  private phase(k: number): string {
    const name = `wave-${k}`;
    if (!this.phases.includes(name)) {
      this.phases.push(name);
      this.emit({ type: "phase-start", component: null, phase: name });
    }
    return name;
  }

  start(): void {
    this.emit({ type: "run-start", waves: null });
  }

  /** A target's apply begins. */
  stepStart(k: number, target: string): void {
    const phase = this.phase(k);
    this.emit({ type: "step-start", component: null, phase, step: target });
  }

  /** A target's apply ended, with its time and what its capability knew. */
  stepSettle(k: number, target: string, status: OpWaveTargetSettle, durationMs: number | null, opts: { error?: string; message?: string; facts?: CapabilityTraceFacts } = {}): void {
    const phase = this.phase(k);
    this.settled.add(`${phase}\u0000${target}`);
    if (opts.facts) this.trace?.annotate({ phase, step: target }, opts.facts);
    this.emit({
      type: "step-settle",
      component: null,
      phase,
      step: target,
      status,
      ...(status === "skipped" ? { skip: null } : {}),
      durationMs,
      ...(opts.error !== undefined ? { error: opts.error } : {}),
      ...(opts.message !== undefined ? { message: opts.message } : {}),
    });
  }

  /**
   * The job ended: settle what is still open from its run record, then the
   * run. `moved` and `blocked` give the reason a skipped target says.
   */
  finish(record: OpRunRecordInput, why: { moved?: readonly string[]; blocked?: Readonly<Record<string, string>> } = {}): void {
    const moved = new Set(why.moved ?? []);
    const last = record.phases[record.phases.length - 1]?.name;
    for (const p of record.phases) {
      if (!this.phases.includes(p.name)) {
        this.phases.push(p.name);
        this.emit({ type: "phase-start", component: null, phase: p.name });
      }
      for (const step of p.steps) {
        if (this.settled.has(`${p.name}\u0000${step.fn}`)) continue;
        const status: OpWaveTargetSettle = step.status === "ok" ? "ok" : step.status === "fail" ? "failed" : "skipped";
        const by = why.blocked?.[step.fn];
        const message = moved.has(step.fn) ? "its plan moved since the wave was decided" : by !== undefined ? `blocked by ${by}` : undefined;
        this.emit({
          type: "step-settle",
          component: null,
          phase: p.name,
          step: step.fn,
          status,
          ...(status === "skipped" ? { skip: moved.has(step.fn) ? "refused" : "not-run" } : {}),
          durationMs: status === "skipped" ? null : step.durationMs,
          ...(message ? { message } : {}),
        });
      }
      let status: RunEventSettleStatus = p.status === "fail" ? "failed" : "ok";
      if (p.name === last && (record.status === "gated" || record.status === "waiting")) {
        const gate = record.gate;
        const step = `gate:${gate?.name ?? record.point?.point ?? "point"}`;
        this.emit({ type: "step-start", component: null, phase: p.name, step });
        this.emit({ type: "gate-waiting", component: null, phase: p.name, step, op: gate?.op ?? record.op, gate: gate?.name ?? null, point: record.point?.id ?? null });
        this.emit({ type: "step-settle", component: null, phase: p.name, step, status: record.status, durationMs: null });
        status = record.status;
      }
      this.emit({ type: "phase-settle", component: null, phase: p.name, status });
    }
    const runStatus: RunEventSettleStatus = record.status === "fail" ? "failed" : record.status;
    this.emit({
      type: "run-settle",
      status: runStatus,
      durationMs: Math.max(0, Date.parse(record.ended) - Date.parse(record.started)) || null,
      ...(record.failure ? { failure: { ...record.failure } } : {}),
    });
  }
}
