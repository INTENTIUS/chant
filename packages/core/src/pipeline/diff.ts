/**
 * The folded pipeline's diff (#5324): what a pull request changes in the
 * pipeline, as lines of its folded spec, for the plan note and for a
 * product's `ci --check`.
 */

import { readPipelineAt, type PipelineShow, gitShowPipeline, type PipelineRead } from "./read";
import type { PipelineSpec } from "./spec";

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
  return diff.length === 0 ? undefined : { diff };
}

/** The plan note's section for a pipeline change: a heading and the diff in a fence, every `<!--` written as text. */
export function pipelineChangeSection(change: PipelineChange): string {
  const body = change.refused
    ? [`The pipeline does not fold at the head, so nothing in it can run: ${change.refused}`]
    : ["This pull request changes the pipeline. The folded spec's diff:", "", "```diff", ...change.diff.map((l) => l.split("```").join("` ` `")), "```"];
  return ["### Pipeline", "", ...body].join("\n").split("<!--").join("&lt;!--");
}
