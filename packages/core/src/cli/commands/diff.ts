import { resolve } from "path";
import { readFileSync, existsSync } from "fs";
import { build } from "../../build";
import type { Serializer } from "../../serializer";
import { formatSuccess, formatError, formatBold } from "../format";

/**
 * Diff command options
 */
export interface DiffOptions {
  /** Path to infrastructure directory */
  path: string;
  /** Existing output file to diff against */
  output?: string;
  /** Serializers to use for serialization */
  serializers: Serializer[];
}

/**
 * Diff command result
 */
export interface DiffResult {
  /** Whether the diff succeeded (no build errors) */
  success: boolean;
  /** Whether there are changes between current and previous */
  hasChanges: boolean;
  /** Unified diff output */
  diff: string;
}

/**
 * Execute the diff command
 */
export async function diffCommand(options: DiffOptions): Promise<DiffResult> {
  const infraPath = resolve(options.path);

  // Build current output
  const result = await build(infraPath, options.serializers);

  if (result.errors.length > 0) {
    const messages = result.errors.map((e) => e.message).join("\n");
    return { success: false, hasChanges: false, diff: messages };
  }

  // Combine lexicon outputs (sorted for determinism)
  const combined: Record<string, unknown> = {};
  const sortedLexiconNames = [...result.outputs.keys()].sort();
  for (const lexiconName of sortedLexiconNames) {
    combined[lexiconName] = JSON.parse(result.outputs.get(lexiconName)!);
  }
  const currentOutput = JSON.stringify(combined, sortedJsonReplacer, 2);

  // Read previous output
  let previousOutput = "";
  if (options.output && existsSync(options.output)) {
    previousOutput = readFileSync(resolve(options.output), "utf-8");
  }

  // Produce unified diff
  const diff = unifiedDiff(previousOutput, currentOutput, options.output ?? "(none)");

  return {
    success: true,
    hasChanges: diff.length > 0,
    diff,
  };
}

/**
 * JSON.stringify replacer that sorts object keys for deterministic output
 */
function sortedJsonReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    );
  }
  return value;
}

/**
 * Simple line-by-line unified diff
 */
function unifiedDiff(previous: string, current: string, filename: string): string {
  const prevLines = previous ? previous.split("\n") : [];
  const currLines = current.split("\n");

  // Quick equality check
  if (previous === current) return "";

  const lines: string[] = [];
  lines.push(`--- a/${filename}`);
  lines.push(`+++ b/${filename}`);

  // Simple diff: show removed then added lines using LCS-based approach
  const { added, removed } = diffLines(prevLines, currLines);

  if (removed.size === 0 && added.size === 0) return "";

  // Build hunks
  const allChangedLines = new Set<number>();
  for (const i of removed) allChangedLines.add(i);

  // Map current line indices to approximate previous positions
  let hunkLines: string[] = [];
  const contextSize = 3;

  // Simple approach: output all removals then all additions with context
  if (prevLines.length === 0) {
    // Entirely new file
    lines.push(`@@ -0,0 +1,${currLines.length} @@`);
    for (const line of currLines) {
      lines.push(`+${line}`);
    }
  } else {
    // Use LCS result to produce interleaved diff
    const { ops } = lcsOps(prevLines, currLines);
    lines.push(`@@ -1,${prevLines.length} +1,${currLines.length} @@`);
    for (const op of ops) {
      lines.push(op);
    }
  }

  return lines.join("\n");
}

/**
 * Compute which lines were added and removed between two line arrays
 */
function diffLines(
  prev: string[],
  curr: string[]
): { added: Set<number>; removed: Set<number> } {
  const prevSet = new Map<string, number[]>();
  for (let i = 0; i < prev.length; i++) {
    const existing = prevSet.get(prev[i]) ?? [];
    existing.push(i);
    prevSet.set(prev[i], existing);
  }

  const added = new Set<number>();
  const removed = new Set<number>(prev.map((_, i) => i));

  for (let i = 0; i < curr.length; i++) {
    const indices = prevSet.get(curr[i]);
    if (indices && indices.length > 0) {
      removed.delete(indices.shift()!);
    } else {
      added.add(i);
    }
  }

  return { added, removed };
}

/**
 * Produce diff operations using a simple LCS approach
 */
function lcsOps(prev: string[], curr: string[]): { ops: string[] } {
  // For small diffs, use O(n*m) LCS; for large ones, fall back to simple
  const maxSize = 10000;
  if (prev.length * curr.length > maxSize) {
    // Fall back to simple remove-all/add-all
    const ops: string[] = [];
    for (const line of prev) ops.push(`-${line}`);
    for (const line of curr) ops.push(`+${line}`);
    return { ops };
  }

  // Standard LCS DP
  const m = prev.length;
  const n = curr.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (prev[i - 1] === curr[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce ops
  const ops: string[] = [];
  let i = m;
  let j = n;
  const result: string[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && prev[i - 1] === curr[j - 1]) {
      result.push(` ${prev[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push(`+${curr[j - 1]}`);
      j--;
    } else {
      result.push(`-${prev[i - 1]}`);
      i--;
    }
  }

  return { ops: result.reverse() };
}

/**
 * Print diff result to console
 */
export function printDiffResult(result: DiffResult): void {
  if (!result.success) {
    console.error(formatError({ message: result.diff }));
    return;
  }
  if (result.diff) {
    console.log(result.diff);
  } else {
    console.error(formatSuccess("No changes detected"));
  }
}
