/**
 * `chant workspace records --kind <path> [--current] [--at <rev>] [--json]`,
 * the first-test slice of the records query (#2546, #2536).
 *
 * It reads every record the kind file locates and prints them, with reason
 * codes for any that are invalid. An invalid record never fails the command:
 * the exit code is 0 whenever the read itself worked. Only a kind, schema or
 * revision that cannot be read exits 1.
 *
 * It needs no `chant.workspace.json`. The kind is passed explicitly, so
 * nothing is inferred (#2525 rule 1).
 */

import { relative } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { gitRevisionSource, gitRoot, resolveRevision, workingTreeSource } from "./record-source";
import { loadRecordKind, readRecords, RecordReadError, type ReadErrorCode, type RecordEntry } from "./records";

/** The version of the `records` output this chant writes. */
export const RECORDS_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the `--json` output, shipped beside this file. */
export const RECORDS_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/records/v1/records.schema.json";

const USAGE = "chant workspace records --kind <kind file> [--current] [--at <rev>] [--json]";

export interface RecordsQuery {
  kind: string;
  current?: boolean;
  at?: string;
  /** Where `kind` is resolved from and the repository is found. */
  cwd: string;
}

/** The `records` output: a result, or a failure with one error code. */
export type RecordsDocument =
  | {
      $schema: string;
      contract: number;
      kind: { name: string; schema: string; file: string };
      at: string | null;
      current: boolean;
      records: RecordEntry[];
      summary: { total: number; valid: number; invalid: number; superseded: number };
    }
  | { $schema: string; contract: number; error: { code: ReadErrorCode; message: string } };

/** Run the query and build the document `--json` prints. Never throws a {@link RecordReadError}. */
export async function queryRecords(query: RecordsQuery): Promise<RecordsDocument> {
  const top = gitRoot(query.cwd);
  const root = top ?? query.cwd;
  try {
    const loaded = await loadRecordKind(query.kind, query.cwd);
    let at: string | null = null;
    let source = workingTreeSource(root);
    if (query.at !== undefined) {
      if (!top) throw new RecordReadError("not-a-git-repository", "--at reads git objects, and this directory is not in a git repository");
      at = resolveRevision(top, query.at);
      source = gitRevisionSource(top, at);
    }
    const result = await readRecords(loaded, { root, source, current: !!query.current });
    return {
      $schema: RECORDS_OUTPUT_SCHEMA_ID,
      contract: RECORDS_CONTRACT_VERSION,
      kind: {
        name: loaded.kind.name,
        schema: loaded.kind.schema.id,
        file: relative(root, loaded.file).split("\\").join("/"),
      },
      at,
      current: !!query.current,
      records: result.records,
      summary: result.summary,
    };
  } catch (err) {
    if (!(err instanceof RecordReadError)) throw err;
    return { $schema: RECORDS_OUTPUT_SCHEMA_ID, contract: RECORDS_CONTRACT_VERSION, error: { code: err.code, message: err.message } };
  }
}

export async function runWorkspaceRecords(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (!args.kind) {
    console.error(formatError({ message: "--kind <kind file> is required", hint: USAGE }));
    return 1;
  }
  const doc = await queryRecords({ kind: args.kind, current: args.current, at: args.at, cwd: process.cwd() });
  if (args.json) {
    console.log(JSON.stringify(doc, null, 2));
  } else if ("error" in doc) {
    console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
  } else {
    console.log(formatRecords(doc.records, doc.summary, doc.at));
  }
  return "error" in doc ? 1 : 0;
}

function formatRecords(records: RecordEntry[], summary: { total: number; valid: number; invalid: number; superseded: number }, at: string | null): string {
  const lines: string[] = [];
  const idWidth = Math.max(2, ...records.map((r) => (r.id ?? "-").length));
  const stateWidth = Math.max(5, ...records.map((r) => (r.state ?? "-").length));
  for (const r of records) {
    const title = typeof r.data?.title === "string" ? r.data.title : r.path;
    const flag = r.valid ? "" : "  INVALID";
    const superseded = r.supersededBy ? `  superseded by ${r.supersededBy}` : "";
    lines.push(`${(r.id ?? "-").padEnd(idWidth)}  ${(r.state ?? "-").padEnd(stateWidth)}  ${title}${superseded}${flag}`);
    for (const reason of r.reasons) lines.push(`${" ".repeat(idWidth + 2)}${reason.code}: ${reason.message} (${r.path})`);
  }
  lines.push(
    `${summary.total} records${at ? ` at ${at.slice(0, 8)}` : ""}: ${summary.valid} valid, ${summary.invalid} invalid, ${summary.superseded} superseded`,
  );
  return lines.join("\n");
}

/** `chant workspace <anything else>`. */
export async function runWorkspaceUnknown(ctx: CommandContext): Promise<number> {
  const sub = ctx.args.path && ctx.args.path !== "." ? ctx.args.path : "";
  console.error(
    formatError({
      message: sub ? `Unknown workspace subcommand: ${sub}` : "chant workspace needs a subcommand",
      hint: `Workspace subcommands: audit, build, check, graph, init, lineage, lint, ls, records, status, upgrade. Run "chant --help" for their options.`,
    }),
  );
  return 1;
}
