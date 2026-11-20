/**
 * The folded pipeline's diff (#5324): what a pull request changes in the
 * pipeline, as lines of its folded spec, for the plan note and for a
 * product's `ci --check`.
 */

import { readPipelineAt, type PipelineShow, gitShowPipeline, type PipelineRead } from "./read";
import { canaryStagesBefore, stageUpstreams, type PipelineHold, type PipelineSpec, type PipelineStage } from "./spec";
import { isQuorumAll, isQuorumAny, isQuorumGroup, quorumNodes, type GateQuorumNode } from "../op/gate-quorum";
import { soakSummary } from "./soak";

/**
 * The plan note's section for the soaks a change passes through once it
 * merges (#5326): each stage's soak, with the stages it holds, and each
 * wave's, with the wave it holds. Read from the pipeline at base, which is
 * where the gates are read. Undefined when nothing soaks.
 */
export function pipelineSoakSection(spec: PipelineSpec | undefined): string | undefined {
  if (!spec) return undefined;
  const lines: string[] = [];
  for (const stage of spec.stages) {
    stage.waves.forEach((w, k) => {
      const next = stage.waves[k + 1];
      // #5327: a canary wave with no soak of its own takes the stage's, and holds every wave after it.
      const soak = w.soak ?? (w.canary ? stage.soak : undefined);
      if (!soak || !next) return;
      if (w.canary) lines.push(`- In \`${stage.name}\`, every wave after the canary wave \`${w.name}\` waits for it to soak: ${soakSummary(soak)}.`);
      else lines.push(`- In \`${stage.name}\`, wave \`${next.name}\` waits for wave \`${w.name}\` to soak: ${soakSummary(soak)}.`);
    });
    if (!stage.soak) continue;
    const holds = spec.stages.filter((s) => stageUpstreams(spec, s.name).includes(stage.name)).map((s) => `\`${s.name}\``);
    lines.push(
      holds.length > 0
        ? `- A promotion from \`${stage.name}\` into ${holds.join(", ")} waits for \`${stage.name}\` to soak: ${soakSummary(stage.soak)}.`
        : `- \`${stage.name}\` soaks after it applies: ${soakSummary(stage.soak)}.`,
    );
    // #5327: the canary's soak holds every stage after it, not only the next.
    const later = stage.canary ? spec.stages.filter((s) => canaryStagesBefore(spec, s.name).some((c) => c.name === stage.name) && !stageUpstreams(spec, s.name).includes(stage.name)).map((s) => `\`${s.name}\``) : [];
    if (later.length > 0) lines.push(`- \`${stage.name}\` is the canary: a promotion into ${later.join(", ")} waits for its soak too.`);
  }
  if (lines.length === 0) return undefined;
  return ["### Soak", "", "Once this merges, the change passes through these soaks. Each one holds and never approves; a person can end one early through its gate.", "", ...lines].join("\n").split("<!--").join("&lt;!--");
}

/** The folded spec's lines, as the diff compares them. */
export function pipelineSpecLines(spec: PipelineSpec | undefined): string[] {
  return spec === undefined ? [] : JSON.stringify(spec, null, 2).split("\n");
}

/** A line diff of `before` against `after`, each line marked ` `, `-` or `+`. Unchanged runs longer than `context` lines each side are cut. */
export function lineDiff(before: readonly string[], after: readonly string[], context = 3): string[] {
  const n = before.length;
  const m = after.length;
  // Longest common subsequence, by suffix.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const all: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      all.push(` ${before[i]}`);
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      all.push(`-${before[i]}`);
      i++;
    } else {
      all.push(`+${after[j]}`);
      j++;
    }
  }
  const near = all.map((_, k) => all.slice(Math.max(0, k - context), k + context + 1).some((l) => !l.startsWith(" ")));
  const out: string[] = [];
  let cut = false;
  all.forEach((line, k) => {
    if (near[k]) {
      out.push(line);
      cut = false;
    } else if (!cut) {
      out.push(" ...");
      cut = true;
    }
  });
  return out.some((l) => l.startsWith("+") || l.startsWith("-")) ? out : [];
}

/** What a pull request does to the pipeline, read at two commits. */
export interface PipelineChange {
  /** The folded spec's diff; empty when the folded spec did not change. */
  diff: string[];
  /** The head's file is outside the subset: its finding, in place of a diff. */
  refused?: string;
  /**
   * What a reader of the change needs before it merges (#5354), one line
   * each: each stage held at the head, each hold the change lifts, with what
   * the person who lifts it reads first, and each stage gate whose rules
   * are named or grouped. Absent when there is none.
   */
  notes?: string[];
}

/** One rule or group, in words (#5354): `fast-path: any of (release-manager: 1 approval from release-manager)`. */
export function quorumNodeWords(n: GateQuorumNode): string {
  const named = (text: string) => (n.name !== undefined ? `${n.name}: ${text}` : text);
  if (isQuorumGroup(n)) {
    const kids = (isQuorumAll(n) ? n.all : isQuorumAny(n) ? n.any : []).map(quorumNodeWords);
    return named(`${isQuorumAll(n) ? "all" : "any"} of (${kids.join("; ")})`);
  }
  const parts = [`${n.count} approval${n.count === 1 ? "" : "s"}`];
  if (n.roles?.length) parts.push(`from ${n.roles.join(" or ")}`);
  if (n.proven) parts.push("proven");
  if (n.notAuthor) parts.push("one not the author");
  if (n.targets?.length) parts.push(`on ${n.targets.join(", ")}`);
  return named(parts.join(" "));
}

function holdWords(hold: PipelineHold): { until: string; reason: string; read: string } {
  const h = hold === true ? {} : hold;
  return {
    until: h.until ? ` until ${h.until}` : "",
    reason: h.reason ? ` (${h.reason})` : "",
    read: h.description ? ` Before it goes on: ${h.description}` : "",
  };
}

/** The notes for a change from `before` to `after` (#5354): holds at the head, holds lifted, and named or grouped gate rules. */
export function pipelineChangeNotes(before: PipelineSpec | undefined, after: PipelineSpec | undefined): string[] {
  const out: string[] = [];
  const at = (spec: PipelineSpec | undefined, name: string): PipelineStage | undefined => spec?.stages.find((s) => s.name === name);
  for (const stage of before?.stages ?? []) {
    if (stage.hold === undefined || at(after, stage.name)?.hold !== undefined) continue;
    const w = holdWords(stage.hold);
    out.push(`This change lifts the hold on stage ${stage.name}${w.reason}.${w.read}`);
  }
  for (const stage of after?.stages ?? []) {
    if (stage.hold !== undefined) {
      const w = holdWords(stage.hold);
      out.push(`Stage ${stage.name} is held${w.until}${w.reason}.${w.read}`);
    }
    const nodes = quorumNodes(stage.gate?.quorum);
    const shown = (n: GateQuorumNode): boolean => n.name !== undefined || isQuorumGroup(n);
    if (nodes.some(shown)) out.push(`Stage ${stage.name}'s gate takes all of: ${nodes.map(quorumNodeWords).join("; ")}.`);
  }
  return out;
}

function specOf(read: PipelineRead): PipelineSpec | undefined {
  return read.status === "folded" ? read.spec : undefined;
}

/**
 * The pipeline change between `base` and `head` in the member at `cwd`, or
 * undefined when neither commit has a pipeline or its folded spec is the
 * same at both. Reads both commits' files and folds them: nothing runs.
 */
export function pipelineChange(base: string, head: string, cwd: string, show: PipelineShow = gitShowPipeline): PipelineChange | undefined {
  const before = readPipelineAt(base, cwd, show);
  const after = readPipelineAt(head, cwd, show);
  if (before.status === "absent" && after.status === "absent") return undefined;
  if (after.status === "refused") return { diff: [], refused: after.line };
  const diff = lineDiff(pipelineSpecLines(specOf(before)), pipelineSpecLines(specOf(after)));
  if (diff.length === 0) return undefined;
  const notes = pipelineChangeNotes(specOf(before), specOf(after));
  return { diff, ...(notes.length > 0 ? { notes } : {}) };
}

/** The plan note's section for a pipeline change: a heading and the diff in a fence, every `<!--` written as text. */
export function pipelineChangeSection(change: PipelineChange): string {
  const body = change.refused
    ? [`The pipeline does not fold at the head, so nothing in it can run: ${change.refused}`]
    : [
        // #5354: the holds and named rules first, so the person who lifts a hold reads what it asks.
        ...(change.notes ?? []).flatMap((n) => [`- ${n.split("`").join("'")}`]),
        ...(change.notes?.length ? [""] : []),
        "This pull request changes the pipeline. The folded spec's diff:",
        "",
        "```diff",
        ...change.diff.map((l) => l.split("```").join("` ` `")),
        "```",
      ];
  return ["### Pipeline", "", ...body].join("\n").split("<!--").join("&lt;!--");
}
