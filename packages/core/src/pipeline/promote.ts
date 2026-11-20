/**
 * What a promote reads from the folded pipeline (#5324).
 *
 * `chant components promote --to <stage>` in a member with a pipeline reads
 * it at the default branch's tip (`./read.ts`'s `promoteBase`):
 *
 * 1. A held stage, or one in a freeze window, refuses with exit 3 and says
 *    until when.
 * 2. `--from` defaults to the stage before; a promote that skips a stage is
 *    refused, as with `environments`. `--allow-skip` passes only through
 *    each skipped stage's gate: gate `<stage>-skip` under the pipeline's
 *    op, bound to the promoted digest, unless that stage's gate policy is
 *    `never`. A held skipped stage refuses too. Each skip is recorded on
 *    `_gates/<pipeline>/applied.jsonl`, which spends the approval it went
 *    through.
 * 3. The target stage's gate: gate `<stage>` under the pipeline's op, bound
 *    to the release's digest (or the promoted digests'), with the stage's
 *    quorum rules. A policy of `never` lets it through; `always` and
 *    `on-destructive` wait, since a promote has no plan to call destructive
 *    before it is gated.
 *
 * A gate that waits records its pending fact and the promote exits 3, as a
 * gated run does; `chant approve <pipeline> <gate> --plan <digest>` passes it.
 */

import { createHash } from "node:crypto";
import { approveCommand, evaluateGate, type GateLedgerPort } from "../op/gate";
import type { PipelineSpec, PipelineStage } from "./spec";
import { stageHeldAt, stageHeldLine } from "./stages";

/** A refusal or a wait, with the exit code the promote ends with. */
export interface PipelinePromoteStop {
  exitCode: number;
  message: string;
  hint?: string;
  code?: "pipeline-stage-held" | "promote-skips-environment" | "promote-no-previous-environment" | "pipeline-gate-waiting";
}

/** The digest a stage gate binds when there is no release: the components and digests promoted, in order. */
export function promotedDigest(items: readonly { component: string; digest: string }[]): string {
  const canonical = JSON.stringify([...items].map((i) => [i.component, i.digest]).sort());
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * The order and holds part, before anything is planned: the stage promoted
 * from, or a stop. `undefined` when the pipeline has no stage `to`, so the
 * pipeline has nothing to say about it.
 */
export function pipelinePromoteSource(input: {
  spec: PipelineSpec;
  to: string;
  from?: string;
  allowSkip?: boolean;
  now: Date;
}): { from: string; skipped: PipelineStage[] } | PipelinePromoteStop | undefined {
  const { spec, to, now } = input;
  const names = spec.stages.map((s) => s.name);
  const toAt = names.indexOf(to);
  if (toAt < 0) return undefined;
  const held = stageHeldAt(spec.stages[toAt]!, now);
  if (held) return { exitCode: 3, code: "pipeline-stage-held", message: stageHeldLine(held), hint: held.until ? `Promote again after ${held.until}.` : "Lift the hold in the pipeline's config and merge the change." };
  const from = input.from ?? (toAt > 0 ? names[toAt - 1] : undefined);
  if (from === undefined) {
    return { exitCode: 1, code: "promote-no-previous-environment", message: `"${to}" is the first stage of the pipeline "${spec.name}" (${names.join(", ")}): a merge applies it, so there is nothing to promote from` };
  }
  const fromAt = names.indexOf(from);
  const skipped = fromAt >= 0 && fromAt < toAt - 1 ? spec.stages.slice(fromAt + 1, toAt) : [];
  if (skipped.length > 0 && !input.allowSkip) {
    return {
      exitCode: 1,
      code: "promote-skips-environment",
      message: `promoting ${from} to ${to} skips ${skipped.map((s) => s.name).join(", ")} in the pipeline's stage order (${names.join(", ")})`,
      hint: `Promote to ${skipped[0]!.name} first, or pass --allow-skip to go through the gate of each stage skipped.`,
    };
  }
  for (const s of skipped) {
    const h = stageHeldAt(s, now);
    if (h) return { exitCode: 3, code: "pipeline-stage-held", message: `${stageHeldLine(h)}; a skip goes through it, so nothing is promoted past it either` };
  }
  return { from, skipped };
}

/** What {@link pipelinePromoteGates} decided: every gate passed, or the stop. */
export type PipelineGatesOutcome = { passed: true; lines: string[] } | ({ passed: false } & PipelinePromoteStop);

/**
 * The gates part, once the promote knows what it deploys: each skipped
 * stage's skip gate, then the target stage's gate. `digest` is the release's
 * digest, or {@link promotedDigest}. Records each skip it passes.
 */
export async function pipelinePromoteGates(input: {
  spec: PipelineSpec;
  to: string;
  skipped: readonly PipelineStage[];
  digest: string;
  releaseDigest?: string;
  port: GateLedgerPort;
  actor?: string;
  gitSha?: string;
  now: Date;
}): Promise<PipelineGatesOutcome> {
  const { spec, port, digest } = input;
  const now = input.now.toISOString();
  const lines: string[] = [];
  const check = async (stage: PipelineStage, gate: string) => {
    const rules = stage.gate?.quorum;
    return evaluateGate(port, {
      op: spec.name,
      gate,
      planDigest: digest,
      environment: stage.name,
      now,
      description: gate.endsWith("-skip") ? `skip stage ${stage.name} of the pipeline ${spec.name}` : `promote into stage ${stage.name} of the pipeline ${spec.name}`,
      ...(input.gitSha ? { gitSha: input.gitSha } : {}),
      ...(rules && rules.length > 0 ? { approval: { quorum: rules, mode: "enforce" as const } } : {}),
    });
  };
  const waiting = (gate: string, stage: string): PipelineGatesOutcome => ({
    passed: false,
    exitCode: 3,
    code: "pipeline-gate-waiting",
    message: `${spec.name} ${gate} waits for an approval of ${digest}`,
    hint: approveCommand(spec.name, gate, stage, digest),
  });

  for (const stage of input.skipped) {
    const gate = `${stage.name}-skip`;
    if (stage.gate?.policy === "never") {
      await port.appendApplied?.({ version: 1, kind: "applied", op: spec.name, gate, planDigest: digest, approvedAt: now, approvedBy: "gate-policy-never", timestamp: now, ...(input.gitSha ? { commit: input.gitSha } : {}) });
      lines.push(`skipped ${stage.name}: its gate never waits`);
      continue;
    }
    const got = await check(stage, gate);
    if (!got.satisfied) return waiting(gate, stage.name);
    await port.appendApplied?.({ version: 1, kind: "applied", op: spec.name, gate, planDigest: digest, approvedAt: got.resolution.timestamp, approvedBy: got.resolution.resolvedBy, timestamp: now, ...(input.gitSha ? { commit: input.gitSha } : {}) });
    lines.push(`skipped ${stage.name} through ${spec.name} ${gate}, approved by ${got.resolution.resolvedBy}`);
  }

  const stage = spec.stages.find((s) => s.name === input.to)!;
  if (stage.gate?.policy === "never") {
    lines.push(`stage ${stage.name}: its gate never waits`);
    return { passed: true, lines };
  }
  const got = await check(stage, stage.name);
  if (!got.satisfied) return waiting(stage.name, stage.name);
  lines.push(`stage ${stage.name}: ${spec.name} ${stage.name} approved by ${got.resolution.resolvedBy}`);
  return { passed: true, lines };
}
