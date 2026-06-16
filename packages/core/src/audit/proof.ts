/**
 * Proof of minimal change — for a deterministic (fixKind: "deterministic")
 * finding, produce a minimal patched YAML + unified diff so a PR can show it
 * changes exactly the flagged line and nothing else.
 *
 * No LLM, no API key — purely mechanical text edits. Findings that need
 * judgment (fixKind: "guidance") are NOT auto-fixed here; they return
 * `applied: false` with the catalog remediation as guidance. Any LLM-assisted
 * apply of a guidance fix is a separate, optional, local concern.
 *
 * Edits are applied directly to the YAML text (not via a model round-trip), so
 * the patched output differs only where intended — the diff proves it.
 */

import { RULE_CATALOG } from "./catalog";

export interface ProveOptions {
  /** Resolve an action ref (e.g. "actions/checkout@v4") to a 40-char SHA. */
  resolveSha?: (action: string, ref: string) => string | undefined;
  /** Resolve a container image (e.g. "node:20") to a "sha256:..." digest. */
  resolveDigest?: (image: string) => string | undefined;
}

export interface ProofResult {
  checkId: string;
  /** True when a deterministic fix was produced. */
  applied: boolean;
  /** Full patched content (only when applied). */
  patched?: string;
  /** Unified diff of the change (only when applied). */
  diff?: string;
  /** Guidance/explanation when not applied (guidance fix, no-op, or needs-sha). */
  note?: string;
  /**
   * Why the result is what it is:
   *  - applied: a fix was produced
   *  - noop: nothing to fix (issue absent, or already resolved by a prior fix)
   *  - needs-input: deterministic but blocked on external input (e.g. a SHA)
   *  - guidance: not auto-fixable; needs human judgement
   */
  reason: "applied" | "noop" | "needs-input" | "guidance";
}

const SHA_RE = /^[0-9a-f]{40}$/;
const USES_RE = /^(\s*-?\s*uses:\s*)([^@\s'"]+)@([^\s'"#]+)(.*)$/;
const IMAGE_RE = /^(\s*image:\s*)(["']?)([^\s"'#]+)\2(.*)$/;

function notApplied(checkId: string, reason: "noop" | "needs-input" | "guidance", note: string): ProofResult {
  return { checkId, applied: false, reason, note };
}

/** Extract unpinned `uses: action@ref` references (deduped) from workflow YAML. */
export function extractUnpinnedActions(content: string): Array<{ action: string; ref: string }> {
  const seen = new Set<string>();
  const out: Array<{ action: string; ref: string }> = [];
  for (const line of content.split("\n")) {
    const m = line.match(USES_RE);
    if (!m) continue;
    const [, , action, ref] = m;
    if (SHA_RE.test(ref)) continue;
    const key = `${action}@${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ action, ref });
  }
  return out;
}

/** Pin unpinned `uses: action@ref` lines to a SHA. */
function pinActions(content: string, opts: ProveOptions): { patched: string; changed: boolean; needsSha: boolean } {
  const lines = content.split("\n");
  let changed = false;
  let needsSha = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(USES_RE);
    if (!m) continue;
    const [, prefix, action, ref, rest] = m;
    if (SHA_RE.test(ref)) continue; // already pinned
    const sha = opts.resolveSha?.(action, ref);
    if (!sha) {
      needsSha = true;
      continue;
    }
    lines[i] = `${prefix}${action}@${sha}  # ${ref}${rest.replace(/\s*#.*$/, "")}`;
    changed = true;
  }
  return { patched: lines.join("\n"), changed, needsSha };
}

/** A container image is unpinnable here if it lacks a digest and isn't a variable. */
function isPinnableImage(ref: string): boolean {
  return !ref.includes("@sha256:") && !ref.includes("$");
}

/** Extract unpinned `image:` references (deduped) from CI YAML. */
export function extractUnpinnedImages(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(IMAGE_RE);
    if (!m) continue;
    const ref = m[3];
    if (!isPinnableImage(ref) || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/** Pin unpinned `image:` references to a digest via the resolver. */
function pinImages(content: string, opts: ProveOptions): { patched: string; changed: boolean; needsValue: boolean } {
  const lines = content.split("\n");
  let changed = false;
  let needsValue = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(IMAGE_RE);
    if (!m) continue;
    const [, prefix, , ref, rest] = m;
    if (!isPinnableImage(ref)) continue;
    const digest = opts.resolveDigest?.(ref);
    if (!digest) {
      needsValue = true;
      continue;
    }
    lines[i] = `${prefix}${ref}@${digest}${rest.replace(/\s*#.*$/, "")}`;
    changed = true;
  }
  return { patched: lines.join("\n"), changed, needsValue };
}

/** Insert a least-privilege top-level permissions block if absent. */
function addPermissions(content: string): { patched: string; changed: boolean } {
  if (/^permissions:/m.test(content)) return { patched: content, changed: false };
  const lines = content.split("\n");
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsIdx === -1) return { patched: content, changed: false };
  lines.splice(jobsIdx, 0, "permissions:", "  contents: read");
  return { patched: lines.join("\n"), changed: true };
}

/** Replace a top-level `permissions: write-all` with a least-privilege block. */
function narrowWriteAll(content: string): { patched: string; changed: boolean } {
  const re = /^permissions:[ \t]+write-all[ \t]*$/m;
  if (!re.test(content)) return { patched: content, changed: false };
  return { patched: content.replace(re, "permissions:\n  contents: read"), changed: true };
}

/**
 * Produce a deterministic fix + diff for a finding, if one is mechanical.
 * Returns `applied: false` with guidance for non-deterministic findings.
 */
export function proveFix(checkId: string, content: string, opts: ProveOptions = {}): ProofResult {
  const cat = RULE_CATALOG[checkId];
  if (cat && cat.fixKind !== "deterministic") {
    return notApplied(checkId, "guidance", cat.remediation || "Manual fix required.");
  }

  let result: { patched: string; changed: boolean; needsSha?: boolean };
  switch (checkId) {
    case "GHA021":
    case "GHA029":
      result = pinActions(content, opts);
      if (!result.changed && (result as { needsSha?: boolean }).needsSha) {
        return notApplied(checkId, "needs-input", "A commit SHA is required to pin; resolve it (e.g. via the fetch layer) and re-run.");
      }
      break;
    case "GHA030":
    case "WGL031": {
      const r = pinImages(content, opts);
      if (!r.changed && r.needsValue) {
        return notApplied(checkId, "needs-input", "A registry digest is required to pin the image; resolve it (e.g. via the fetch layer) and re-run.");
      }
      result = r;
      break;
    }
    case "GHA017":
      result = addPermissions(content);
      break;
    case "GHA033":
      result = narrowWriteAll(content);
      break;
    default:
      return notApplied(checkId, "needs-input", cat?.remediation || "No deterministic fix implemented for this rule yet.");
  }

  if (!result.changed) {
    return notApplied(checkId, "noop", "Nothing to fix — the issue is not present (no-op).");
  }
  return {
    checkId,
    applied: true,
    reason: "applied",
    patched: result.patched,
    diff: unifiedDiff(content, result.patched),
  };
}

// ── Minimal line-based unified diff ──────────────────────────────────

type Op = { type: "eq" | "del" | "add"; line: string };

/** LCS-based line diff. */
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: "del", line: a[i] });
      i++;
    } else {
      ops.push({ type: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", line: a[i++] });
  while (j < m) ops.push({ type: "add", line: b[j++] });
  return ops;
}

/** Render a unified diff with up to `context` equal lines around changes. */
export function unifiedDiff(oldStr: string, newStr: string, context = 3): string {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  const ops = diffOps(a, b);

  // Mark which op indexes are within `context` of a change.
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== "eq") {
      for (let d = -context; d <= context; d++) {
        const idx = k + d;
        if (idx >= 0 && idx < ops.length) keep[idx] = true;
      }
    }
  }

  const lines: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      if (ops[k].type !== "add") oldLine++;
      if (ops[k].type !== "del") newLine++;
      k++;
      continue;
    }
    // Start of a hunk.
    const hunk: string[] = [];
    const oldStart = oldLine;
    const newStart = newLine;
    let oldCount = 0;
    let newCount = 0;
    while (k < ops.length && keep[k]) {
      const op = ops[k];
      if (op.type === "eq") {
        hunk.push(` ${op.line}`);
        oldCount++;
        newCount++;
        oldLine++;
        newLine++;
      } else if (op.type === "del") {
        hunk.push(`-${op.line}`);
        oldCount++;
        oldLine++;
      } else {
        hunk.push(`+${op.line}`);
        newCount++;
        newLine++;
      }
      k++;
    }
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    lines.push(...hunk);
  }
  return lines.join("\n");
}
