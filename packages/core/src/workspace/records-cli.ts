/**
 * `chant workspace records --kind <path> [--current] [--json]`, the
 * first-test slice of the records query (#2546). `--at <rev>` and the
 * published output schema follow in #2536's slice.
 *
 * It reads every record the kind file locates and prints them, with reason
 * codes for any that are invalid. An invalid record never fails the command:
 * the exit code is 0 whenever the read itself worked. Only a kind or schema
 * that cannot be read exits 1.
 *
 * It needs no `chant.workspace.json`. The kind is passed explicitly, so
 * nothing is inferred (#2525 rule 1).
 */

import { relative } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { gitRoot, workingTreeSource } from "./record-source";
import { loadRecordKind, readRecords, RecordReadError, type ReadErrorCode, type RecordEntry } from "./records";

/** The version of the `records` output this chant writes. */
export const RECORDS_CONTRACT_VERSION = 1;

const USAGE = "chant workspace records --kind <kind file> [--current] [--json]";

export interface RecordsQuery {
  kind: string;
  current?: boolean;
  /** Where `kind` is resolved from and the repository is found. */
  cwd: string;
}

/** The `records` output: a result, or a failure with one error code. */
export type RecordsDocument =
  | {
      contract: number;
      kind: { name: string; schema: string; file: string };
      current: boolean;
      records: RecordEntry[];
      summary: { total: number; valid: number; invalid: number; superseded: number };
    }
  | { contract: number; error: { code: ReadErrorCode; message: string } };

/** Run the query and build the document `--json` prints. Never throws a {@link RecordReadError}. */
export async function queryRecords(query: RecordsQuery): Promise<RecordsDocument> {
  const root = gitRoot(query.cwd) ?? query.cwd;
  try {
    const loaded = await loadRecordKind(query.kind, query.cwd);
    const result = await readRecords(loaded, { root, source: workingTreeSource(root), current: !!query.current });
    return {
      contract: RECORDS_CONTRACT_VERSION,
      kind: {
        name: loaded.kind.name,
        schema: loaded.kind.schema.id,
        file: relative(root, loaded.file).split("\\").join("/"),
      },
      current: !!query.current,
      records: result.records,
      summary: result.summary,
    };
  } catch (err) {
    if (!(err instanceof RecordReadError)) throw err;
    return { contract: RECORDS_CONTRACT_VERSION, error: { code: err.code, message: err.message } };
  }
}

export async function runWorkspaceRecords(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (!args.kind) {
    console.error(formatError({ message: "--kind <kind file> is required", hint: USAGE }));
    return 1;
  }
  if (args.at !== undefined) {
    console.error(formatError({ message: "--at is not supported by workspace records yet (#2536)", hint: USAGE }));
    return 1;
  }
  const doc = await queryRecords({ kind: args.kind, current: args.current, cwd: process.cwd() });
  if (args.json) {
    console.log(JSON.stringify(doc, null, 2));
  } else if ("error" in doc) {
    console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
  } else {
    console.log(formatRecords(doc.records, doc.summary));
  }
  return "error" in doc ? 1 : 0;
}

function formatRecords(records: RecordEntry[], summary: { total: number; valid: number; invalid: number; superseded: number }): string {
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
    `${summary.total} records: ${summary.valid} valid, ${summary.invalid} invalid, ${summary.superseded} superseded`,
  );
  return lines.join("\n");
}

/** `chant workspace <anything else>`: only `records` exists so far. */
export async function runWorkspaceUnknown(ctx: CommandContext): Promise<number> {
  const sub = ctx.args.path && ctx.args.path !== "." ? ctx.args.path : "";
  console.error(
    formatError({
      message: sub ? `Unknown workspace subcommand: ${sub}` : "chant workspace needs a subcommand",
      hint: `Only records exists so far: ${USAGE}`,
    }),
  );
  return 1;
}
