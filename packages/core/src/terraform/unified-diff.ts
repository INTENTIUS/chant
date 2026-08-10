/**
 * Minimal unified-diff generator for the carve bridge patch (#998). Emits
 * git-applyable hunks (`git apply`, or plain `patch -p1`) so the whole survivor
 * edit — data sources plus rewired references — lands in one reviewable file.
 * LCS-based; bridge inputs are hand-sized `.tf` files, so O(n·m) is fine.
 */

/** One file's diff, `a/<path>` → `b/<path>`, with git headers. Empty when unchanged. */
export function unifiedDiff(path: string, oldText: string, newText: string, context = 3): string {
  if (oldText === newText) return "";

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const ops = diffOps(oldLines.lines, newLines.lines);
  const hunks = buildHunks(ops, context);
  if (hunks.length === 0) return "";

  const L: string[] = [];
  L.push(`diff --git a/${path} b/${path}`);
  L.push(`--- a/${path}`);
  L.push(`+++ b/${path}`);
  for (const hunk of hunks) {
    L.push(`@@ -${hunkRange(hunk.oldStart, hunk.oldCount)} +${hunkRange(hunk.newStart, hunk.newCount)} @@`);
    for (const op of hunk.ops) {
      L.push(`${op.kind === "add" ? "+" : op.kind === "del" ? "-" : " "}${op.line}`);
      if (op.kind !== "add" && op.oldIndex === oldLines.lines.length - 1 && !oldLines.trailingNewline) {
        L.push("\\ No newline at end of file");
      }
      if (op.kind !== "del" && op.newIndex === newLines.lines.length - 1 && !newLines.trailingNewline) {
        L.push("\\ No newline at end of file");
      }
    }
  }
  return L.join("\n") + "\n";
}

/** A new-file diff (`/dev/null` → `b/<path>`), git-applyable. */
export function newFileDiff(path: string, text: string): string {
  const { lines, trailingNewline } = splitLines(text);
  const L: string[] = [];
  L.push(`diff --git a/${path} b/${path}`);
  L.push("new file mode 100644");
  L.push("--- /dev/null");
  L.push(`+++ b/${path}`);
  if (lines.length > 0) {
    L.push(`@@ -0,0 +${hunkRange(1, lines.length)} @@`);
    for (const line of lines) L.push(`+${line}`);
    if (!trailingNewline) L.push("\\ No newline at end of file");
  }
  return L.join("\n") + "\n";
}

function hunkRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${count === 0 ? start - 1 : start},${count}`;
}

function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === "") return { lines: [], trailingNewline: true };
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

interface DiffOp {
  kind: "keep" | "del" | "add";
  line: string;
  /** Index in the old file (keep/del). */
  oldIndex: number;
  /** Index in the new file (keep/add). */
  newIndex: number;
}

/** Line-level LCS diff as a flat op list. */
function diffOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "keep", line: a[i], oldIndex: i, newIndex: j });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "del", line: a[i], oldIndex: i, newIndex: j });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j], oldIndex: i, newIndex: j });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ kind: "del", line: a[i], oldIndex: i, newIndex: j });
  for (; j < m; j++) ops.push({ kind: "add", line: b[j], oldIndex: i, newIndex: j });
  return ops;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  ops: DiffOp[];
}

/** Group change ops into hunks with `context` lines of surrounding keeps. */
function buildHunks(ops: DiffOp[], context: number): Hunk[] {
  const changed = ops.map((op) => op.kind !== "keep");
  const include = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (!changed[k]) continue;
    for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) {
      include[c] = true;
    }
  }

  const hunks: Hunk[] = [];
  let k = 0;
  while (k < ops.length) {
    if (!include[k]) {
      k++;
      continue;
    }
    const start = k;
    while (k < ops.length && include[k]) k++;
    const slice = ops.slice(start, k);
    const oldOps = slice.filter((op) => op.kind !== "add");
    const newOps = slice.filter((op) => op.kind !== "del");
    hunks.push({
      oldStart: (oldOps[0]?.oldIndex ?? slice[0].oldIndex) + 1,
      oldCount: oldOps.length,
      newStart: (newOps[0]?.newIndex ?? slice[0].newIndex) + 1,
      newCount: newOps.length,
      ops: slice,
    });
  }
  return hunks;
}
