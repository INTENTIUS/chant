/**
 * The canary's soak in a gated-wave fan-out (#5327).
 *
 * `chant components fan-out --canary <component> --wave-gate <gate>` puts
 * the canary components the change selects in wave 1. The soak that holds
 * the waves after it is the soak of the pipeline stage the fan-out runs in
 * (`--env`), read from `.chant/pipeline.ts` at the default branch's tip: the
 * same soak, so no key of its own. Before each wave after the canary
 * plans, the run reads it through gate `<gate>-wave-1-soak` under the
 * `fan-out` op (`waveSoakGate`), with its clock at the end of the canary
 * wave's applies (`WaveRecord.settledAt`). While it holds, the run stops
 * with exit 3, as at a gate nobody approved; running the same command
 * again reads it again, and approving that gate ends it early.
 *
 * A canary wave that applied nothing, or whose record is not at hand,
 * gives the soak no clock, so it holds: a canary that did not land never
 * lets the waves after it through on time alone.
 */

import { createHash } from "node:crypto";
import { waveGateName, type WaveRecord } from "../gated-waves";
import type { GateLedgerPort } from "../op/gate";
import { soakAtGate, waveSoakGate, type SoakGateInput } from "../pipeline/soak-gate";
import type { Soak, SoakCheckReader } from "../pipeline/soak";
import type { PipelineSpec } from "../pipeline/spec";
import type { FanOutSoakHold } from "./fan-out-run";

/** The soak of stage `env` in `pipeline`, the one a fan-out's canary takes; undefined when the stage or its soak is absent. */
export function fanOutCanarySoakOf(pipeline: Pick<PipelineSpec, "stages"> | undefined, env: string): Soak | undefined {
  return pipeline?.stages.find((s) => s.name === env)?.soak;
}

/** Whether the plan's first wave is the canary: it holds a component `--canary` named. */
export function fanOutHasCanaryWave(waves: readonly (readonly string[])[], canary: readonly string[]): boolean {
  return (waves[0] ?? []).some((name) => canary.includes(name));
}

export interface FanOutCanarySoakInput {
  /** The op the gates are recorded under, `fan-out`. */
  op: string;
  /** The base wave gate (`--wave-gate`). */
  gate: string;
  soak: Soak;
  /** The environment the fan-out runs in, the stage whose soak this is. */
  env: string;
  /** The canary wave's record as the run knows it now: this attempt's, else the one `--resume` carried. */
  canaryWave: () => WaveRecord | undefined;
  port: GateLedgerPort;
  read: SoakCheckReader;
  now?: () => Date;
  notify?: SoakGateInput["notify"];
  /** Each line a passed soak says. */
  log?: (line: string) => void;
}

/** The `waveGate.soak` hook: the canary's soak in front of wave `k`. */
export function fanOutCanarySoak(input: FanOutCanarySoakInput): (k: number) => Promise<FanOutSoakHold | undefined> {
  return async (k) => {
    const record = input.canaryWave();
    const failed = new Set((record?.failed ?? []).map((f) => f.component));
    const applied = record && record.status !== "gated" ? record.components.filter((c) => !failed.has(c)) : [];
    const digest = record?.digest || `sha256:${createHash("sha256").update(JSON.stringify([input.op, input.gate, 1, "no-run"])).digest("hex")}`;
    const outcome = await soakAtGate({
      op: input.op,
      gate: waveSoakGate(waveGateName(input.gate, 1)),
      soak: input.soak,
      stage: input.env,
      holds: `wave ${k}`,
      wave: 1,
      digest,
      subjects: applied.map((c) => ({ member: c, targets: [c], ...(record?.settledAt ? { appliedAt: record.settledAt } : {}) })),
      port: input.port,
      read: input.read,
      now: input.now?.() ?? new Date(),
      ...(input.notify ? { notify: input.notify } : {}),
    });
    if (outcome.passed) {
      for (const line of outcome.lines) input.log?.(`wave ${k}: ${line}`);
      return undefined;
    }
    return { message: outcome.message, hint: outcome.hint, ...(outcome.recorded ? { pending: outcome.recorded } : {}) };
  };
}
