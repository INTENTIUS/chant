/**
 * HCL parser parity (chant #2483): does a candidate `hcl2json` package hand
 * back the same tree as the one chant ships against?
 *
 * The terraform lexicon reads the parser's tree by hand (`hcl/value.ts`
 * re-derives references from the rendered string, `tf016` depends on how
 * `x = var.y` renders against `x = "${var.y}"`), so a parser that differs
 * anywhere changes lint output silently. The bar is therefore byte identity:
 * the canonical JSON of every parsed tree, and of every
 * `getReferencesInExpression` answer, must match line for line.
 *
 * Inputs come from two places. A corpus walk collects every `.tf` and `.hcl`
 * file under the given roots. A record file, written by the test suite under
 * `CHANT_HCL2JSON_RECORD` (see `packages/core/src/terraform/parse.ts`),
 * replays the inline HCL the tests parse, which no walk would find. Each
 * parsed tree also yields its interpolated strings, which are sent through
 * `getReferencesInExpression` the way core's `collectExpressions` would, so
 * the expression AST is compared on the corpus too.
 *
 * The two parsers never share a process: both register the Go bridge on the
 * same global (`__parse_terraform_config_wasm__`), so each runs in its own
 * worker (see {@link runWorker}) and only the serialized outputs meet.
 *
 * `check-hcl-parser-parity.ts` is the entry point; everything here is pure
 * or takes its I/O as arguments so the comparison can be tested without a
 * wasm blob.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, relative } from "node:path";

/** One thing to ask a parser: a file to parse, or an expression to resolve references in. */
export interface ParityInput {
  /** Stable across both workers; derived from the source, never from ordering. */
  id: string;
  kind: "parse" | "refs";
  filename: string;
  text: string;
}

/** One parser's answer to one input, as the canonical string the comparison reads. */
export interface ParityOutput {
  id: string;
  /** `tree:<json>` or `refs:<json>` on success, `error:<message>` when the parser threw. */
  result: string;
}

/** Why two outputs for the same id differ. */
export type ParityDifferenceKind =
  /** Both parsed; the trees or reference lists differ. */
  | "tree"
  /** One parser threw and the other did not. */
  | "error-status"
  /** Both threw, with different messages. */
  | "error-text"
  /** Only one side produced the id at all (a derived expression the other side's tree did not contain). */
  | "missing";

export interface ParityDifference {
  id: string;
  kind: ParityDifferenceKind;
  reference?: string;
  candidate?: string;
}

export interface ParityReport {
  /** Ids seen on either side. */
  compared: number;
  identical: number;
  differences: ParityDifference[];
}

const HCL_EXTENSIONS = new Set([".tf", ".hcl"]);
const SKIPPED_DIRS = new Set(["node_modules", ".terraform", ".git", "dist"]);

function hasHclExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot !== -1 && HCL_EXTENSIONS.has(name.slice(dot));
}

/** The id an input gets: kind, filename and a content hash, so the same source in two places is one input. */
export function inputId(kind: ParityInput["kind"], filename: string, text: string): string {
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return `${kind}:${filename}:${digest}`;
}

/**
 * Every `.tf` and `.hcl` file under `roots`, recursively, skipping vendored
 * and generated directories. `filename` is the basename, which is all the
 * parser reads from it, and `label` tells a reader where the file came from.
 */
export function collectCorpus(roots: readonly string[], cwd: string): Array<ParityInput & { label: string }> {
  const out: Array<ParityInput & { label: string }> = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry)) walk(path);
      } else if (stat.isFile() && hasHclExtension(entry)) {
        const text = readFileSync(path, "utf-8");
        out.push({ id: inputId("parse", entry, text), kind: "parse", filename: entry, text, label: relative(cwd, path) });
      }
    }
  };
  for (const root of roots) walk(root);
  return out;
}

/** Parse a record file (one JSON line per parser call) into inputs. Malformed lines are skipped. */
export function readRecord(content: string, label = "record"): Array<ParityInput & { label: string }> {
  const out: Array<ParityInput & { label: string }> = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const { kind, filename, text } = parsed as Record<string, unknown>;
    if ((kind !== "parse" && kind !== "refs") || typeof filename !== "string" || typeof text !== "string") continue;
    out.push({ id: inputId(kind, filename, text), kind, filename, text, label: `${label}:${index + 1}` });
  }
  return out;
}

/** Drop inputs whose id was already seen, keeping the first label. */
export function dedupeInputs<T extends ParityInput>(inputs: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const input of inputs) {
    if (seen.has(input.id)) continue;
    seen.add(input.id);
    out.push(input);
  }
  return out;
}

/**
 * The interpolated strings in a tree, the way core's `collectExpressions`
 * finds them: every string value containing `${`, anywhere in the tree,
 * sorted. Core narrows to a few top-level sections; this reads the whole
 * tree so nothing a lexicon might read is left uncompared.
 */
export function interpolatedStrings(tree: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.includes("${")) found.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      for (const inner of Object.values(value as Record<string, unknown>)) visit(inner);
    }
  };
  visit(tree);
  return [...found].sort();
}

/** Line up two output sets by id and classify every disagreement. */
export function compareOutputs(reference: readonly ParityOutput[], candidate: readonly ParityOutput[]): ParityReport {
  const ref = new Map(reference.map((o) => [o.id, o.result]));
  const cand = new Map(candidate.map((o) => [o.id, o.result]));
  const ids = [...new Set([...ref.keys(), ...cand.keys()])].sort();
  const differences: ParityDifference[] = [];
  for (const id of ids) {
    const a = ref.get(id);
    const b = cand.get(id);
    if (a === undefined || b === undefined) {
      differences.push({ id, kind: "missing", reference: a, candidate: b });
      continue;
    }
    if (a === b) continue;
    const aErr = a.startsWith("error:");
    const bErr = b.startsWith("error:");
    const kind: ParityDifferenceKind = aErr && bErr ? "error-text" : aErr !== bErr ? "error-status" : "tree";
    differences.push({ id, kind, reference: a, candidate: b });
  }
  return { compared: ids.length, identical: ids.length - differences.length, differences };
}

/** A canonical, key-order-preserving rendering: what "byte-identical" means here. */
export function canonical(prefix: "tree" | "refs", value: unknown): string {
  return `${prefix}:${JSON.stringify(value)}`;
}

/** Pretty-print one side of a difference for a human, trimmed to `limit` characters. */
function excerpt(result: string | undefined, limit: number): string {
  if (result === undefined) return "(absent)";
  const colon = result.indexOf(":");
  const kind = result.slice(0, colon);
  const body = result.slice(colon + 1);
  let text = body;
  if (kind !== "error") {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      text = body;
    }
  }
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
}

export interface FormatOptions {
  /** How many differences to print in full. */
  show?: number;
  /** Per-side character budget for each printed difference. */
  excerpt?: number;
  /** Where each id came from, for the human line. */
  labels?: ReadonlyMap<string, string>;
}

/** The human report: totals, a breakdown by kind, then the first differences in full. */
export function formatReport(report: ParityReport, options: FormatOptions = {}): string {
  const show = options.show ?? 10;
  const limit = options.excerpt ?? 1200;
  const byKind = new Map<ParityDifferenceKind, number>();
  for (const d of report.differences) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
  const lines: string[] = [];
  lines.push(`HCL parser parity: ${report.identical}/${report.compared} identical, ${report.differences.length} different`);
  for (const [kind, count] of [...byKind.entries()].sort()) lines.push(`  ${kind.padEnd(13)} ${count}`);
  for (const d of report.differences.slice(0, show)) {
    const label = options.labels?.get(d.id);
    lines.push("");
    lines.push(`--- ${d.id}${label ? `  (${label})` : ""}  [${d.kind}]`);
    lines.push("reference:");
    lines.push(excerpt(d.reference, limit));
    lines.push("candidate:");
    lines.push(excerpt(d.candidate, limit));
  }
  if (report.differences.length > show) lines.push(`\n… ${report.differences.length - show} more differences not shown`);
  return lines.join("\n");
}

/** The subset of the parser's exports a worker calls. Same shape core's `Hcl2Json` declares. */
interface ParserModule {
  parse: (filename: string, hcl: string) => Promise<unknown>;
  getReferencesInExpression: (filename: string, expression: string) => Promise<Array<{ value: string }>>;
}

/**
 * Run every input through the parser at `packageDir` and return one output
 * per input, plus one per interpolated string the parse produced (id
 * `refs:<filename>:<hash>`, the same id a recorded call gets, so a recorded
 * expression and a derived one collapse into one comparison).
 *
 * This is the whole of what a worker process does; the entry point feeds it
 * stdin and prints its answer as JSON lines.
 */
export async function runWorker(packageDir: string, inputs: readonly ParityInput[]): Promise<ParityOutput[]> {
  const require = createRequire(join(packageDir, "package.json"));
  const parser = require(packageDir) as ParserModule;
  const outputs: ParityOutput[] = [];
  const seen = new Set<string>();
  const emit = (id: string, result: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    outputs.push({ id, result });
  };
  const refs = async (filename: string, expression: string): Promise<string> => {
    try {
      const found = await parser.getReferencesInExpression(filename, expression);
      return canonical(
        "refs",
        found.map((r) => r.value),
      );
    } catch (err) {
      return `error:${err instanceof Error ? err.message : String(err)}`;
    }
  };
  for (const input of inputs) {
    if (input.kind === "refs") {
      emit(input.id, await refs(input.filename, input.text));
      continue;
    }
    let tree: unknown;
    try {
      tree = await parser.parse(input.filename, input.text);
    } catch (err) {
      emit(input.id, `error:${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    emit(input.id, canonical("tree", tree));
    for (const expression of interpolatedStrings(tree)) {
      const id = inputId("refs", "expression.tf", expression);
      if (!seen.has(id)) emit(id, await refs("expression.tf", expression));
    }
  }
  return outputs;
}

/** The package name a resolved package directory declares, with its version, for the report header. */
export function describePackage(packageDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as { name?: string; version?: string };
    return `${pkg.name ?? basename(packageDir)}@${pkg.version ?? "?"}`;
  } catch {
    return packageDir;
  }
}
