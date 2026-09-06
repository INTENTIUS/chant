/**
 * Read `# chant-ignore*` comments out of raw `.tf` text.
 *
 * `hcl2json` drops comments entirely, and a probe of its output confirmed it
 * exposes no source ranges either, so a suppression comment has nothing to
 * attach to once a file goes through `@cdktf/hcl2json`. This module runs a
 * second, cheap pass over the SAME raw text `./parse.ts` hands the parser,
 * entirely with line-oriented regexes: a brace-depth counter to find each
 * top-level block's start line (`terraform`, `locals`, `provider "x"`,
 * `module "x"`, `variable "x"`, `output "x"`, `resource "t" "n"`,
 * `data "t" "n"`, the exact set `blocksToEntities` turns into entities, and
 * the address format below MUST stay in sync with that function's `add()`
 * calls), and a directive regex for the three comment forms.
 *
 * `scanSuppressions` returns per-file lookups keyed by ADDRESS (`./parse.ts`'s
 * `TerraformEntity.props.address`, e.g. `provider.aws`, `aws_s3_bucket.assets`)
 * rather than by entity, because `blocksToEntities` computes an entity's final
 * map key (with a `~2`/`~3` collision suffix) only after this scan has already
 * run. A FIFO queue per address reconciles the two traversal orders: this
 * scan reads the file top to bottom, but `blocksToEntities` walks hcl2json's
 * tree grouped by section (all `variable` blocks together, then all
 * `resource` blocks, etc.), not in source order. Two blocks that share one
 * address (the same genuinely-duplicated declaration) are matched to their
 * queue slot in file order, same as they're numbered `~2`/`~3` in file order.
 */

import type { SuppressionDirective, SuppressionIds } from "@intentius/chant/lint/suppressions";

/** A block header keyword with zero labels (`terraform {`, `locals {`). */
const BARE_RE = /^\s*(terraform|locals)\s*\{/;
/** One label (`provider "aws" {`, `module "vpc" {`, `variable "x" {`, `output "x" {`). */
const ONE_LABEL_RE = /^\s*(provider|module|variable|output)\s+"([^"]*)"\s*\{/;
/** Two labels (`resource "aws_s3_bucket" "assets" {`, `data "aws_ami" "x" {`). */
const TWO_LABEL_RE = /^\s*(resource|data)\s+"([^"]*)"\s+"([^"]*)"\s*\{/;

/** A `#`/`//` comment naming one of the three suppression forms. */
const DIRECTIVE_RE = /^\s*(?:#|\/\/)\s*chant-ignore(-file|-block)?\s*:?\s*(.*)$/;

/** `./parse.ts`'s own address format per block kind, kept in sync by hand. */
function addressFor(keyword: string, labels: string[]): string {
  switch (keyword) {
    case "terraform":
      return "terraform";
    case "locals":
      return "locals";
    case "provider":
      return `provider.${labels[0]}`;
    case "module":
      return `module.${labels[0]}`;
    case "variable":
      return `var.${labels[0]}`;
    case "output":
      return `output.${labels[0]}`;
    case "resource":
      return `${labels[0]}.${labels[1]}`;
    case "data":
      return `data.${labels[0]}.${labels[1]}`;
    default:
      return "";
  }
}

/** Strip quoted string contents so a brace inside a literal (a jsonencode payload) doesn't skew depth tracking. */
function stripStrings(line: string): string {
  return line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function braceDelta(line: string): number {
  const stripped = stripStrings(line);
  let delta = 0;
  for (const ch of stripped) {
    if (ch === "{") delta++;
    else if (ch === "}") delta--;
  }
  return delta;
}

function parseDirectiveBody(rest: string): { ids: SuppressionIds; expires?: string } {
  const tokens = rest.split(/\s+/).filter(Boolean);
  let expires: string | undefined;
  const idTokens: string[] = [];
  for (const tok of tokens) {
    const m = /^exp:(\d{4}-\d{2}-\d{2})$/.exec(tok);
    if (m) {
      expires = m[1];
      continue;
    }
    idTokens.push(tok);
  }
  const joined = idTokens.join(" ").trim();
  if (joined === "" || joined.toLowerCase() === "all") return { ids: "all", expires };
  const ids = new Set(
    joined
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
  return { ids, expires };
}

/** One file's suppression scan: block start lines by address, and the parsed directives. */
export interface FileScan {
  /** address -> start lines, in file order (a FIFO queue for repeated addresses). */
  blockLineQueues: Map<string, number[]>;
  /** The block start line a `chant-ignore`/`chant-ignore-block` comment anchors to -> directives found there. */
  byAnchorLine: Map<number, SuppressionDirective[]>;
  /** The file's `chant-ignore-file` directive, if any (`misplaced` set when it wasn't the first non-blank line). */
  fileDirective?: SuppressionDirective;
}

function recordBlockLine(queues: Map<string, number[]>, address: string, lineNo: number): void {
  const q = queues.get(address) ?? [];
  q.push(lineNo);
  queues.set(address, q);
}

/**
 * Scan one `.tf` file's raw text. `fileName` only labels the directives it
 * returns (for messages and dedup); the scan itself is pure text.
 */
export function scanSuppressions(fileName: string, source: string): FileScan {
  const lines = source.split("\n");
  const blockLineQueues = new Map<string, number[]>();
  const byAnchorLine = new Map<number, SuppressionDirective[]>();
  let fileDirective: SuppressionDirective | undefined;
  let firstNonBlankLine: number | undefined;
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const trimmed = line.trim();

    if (firstNonBlankLine === undefined && trimmed !== "") firstNonBlankLine = lineNo;

    const directiveMatch = DIRECTIVE_RE.exec(line);
    if (directiveMatch) {
      const suffix = directiveMatch[1];
      const { ids, expires } = parseDirectiveBody(directiveMatch[2].trim());

      if (suffix === "-file") {
        fileDirective = {
          form: "chant-ignore-file",
          ids,
          expires,
          file: fileName,
          line: lineNo,
          misplaced: lineNo !== firstNonBlankLine,
          key: `${fileName}:${lineNo}:chant-ignore-file`,
        };
      } else {
        const form = suffix === "-block" ? "chant-ignore-block" : "chant-ignore";
        const directive: SuppressionDirective = {
          form,
          ids,
          expires,
          file: fileName,
          line: lineNo,
          key: `${fileName}:${lineNo}:${form}`,
        };
        const anchorLine = lineNo + 1;
        const list = byAnchorLine.get(anchorLine) ?? [];
        list.push(directive);
        byAnchorLine.set(anchorLine, list);
      }
    } else if (depth === 0) {
      // Only look for a block header on a line that isn't itself a directive
      // comment, and only at top-level nesting (depth 0 before this line).
      let m: RegExpExecArray | null = BARE_RE.exec(line);
      if (m) {
        recordBlockLine(blockLineQueues, addressFor(m[1], []), lineNo);
      } else if ((m = ONE_LABEL_RE.exec(line))) {
        recordBlockLine(blockLineQueues, addressFor(m[1], [m[2]]), lineNo);
      } else if ((m = TWO_LABEL_RE.exec(line))) {
        recordBlockLine(blockLineQueues, addressFor(m[1], [m[2], m[3]]), lineNo);
      }
    }

    depth += braceDelta(line);
  }

  return { blockLineQueues, byAnchorLine, fileDirective };
}

/** Pop the next recorded start line for `address` (FIFO; see module doc). */
export function popBlockLine(scan: FileScan, address: string): number | undefined {
  const q = scan.blockLineQueues.get(address);
  if (!q || q.length === 0) return undefined;
  return q.shift();
}

/**
 * Directives to attach to the entity being added for `address`: the ones
 * anchored to its own start line (`chant-ignore`/`chant-ignore-block`), plus
 * the file-level one, if any. Every entity in a file carries a file-level
 * directive, misplaced or not (misplaced ones report themselves but suppress
 * nothing; see `applyInlineSuppressions`).
 */
export function directivesFor(scan: FileScan, address: string): { line?: number; suppressions?: SuppressionDirective[] } {
  const line = popBlockLine(scan, address);
  const anchored = line !== undefined ? (scan.byAnchorLine.get(line) ?? []) : [];
  const all = scan.fileDirective ? [...anchored, scan.fileDirective] : anchored;
  return { line, suppressions: all.length > 0 ? all : undefined };
}
