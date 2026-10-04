import { readFileSync } from "node:fs";
import { CHANGE_SET_CONTRACT, CHANGE_SET_SCHEMA_ID, type ChangeSetDocument } from "../../change-set";
import { GITHUB_COMMENT_LIMIT, groupChangeSet, renderPlanSummaryMarkdown, renderPlanSummaryText } from "../../plan-summary";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

const USAGE = "chant change-set summary <change-set.json> [--format text|json|markdown] [--limit <chars>]";

/**
 * `chant change-set summary <file>` (#3188): the grouped plan summary of a
 * change-set document (`../../change-set.ts`), such as the `document` a
 * `composeChangeSet` step returns. `--format` picks text (default), json
 * (the plan-summary schema) or markdown, an MR or PR note of at most
 * `--limit` characters (default GitHub's comment limit, 65536). Reads one
 * file; no project, no plugins, no network.
 */
export async function runChangeSetSummary(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const file = args.extraPositional;
  const format = args.json ? "json" : args.format || "text";
  const fail = (message: string): number => {
    console.error(formatError({ message, hint: USAGE }));
    return 1;
  };
  if (!file) return fail("change-set summary needs the change-set document to read");
  if (format !== "text" && format !== "json" && format !== "markdown") return fail(`--format ${format} is not one of text, json or markdown`);
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 200)) return fail("--limit needs a whole number of characters, at least 200");

  let doc: ChangeSetDocument;
  try {
    doc = JSON.parse(readFileSync(file, "utf-8")) as ChangeSetDocument;
  } catch (err) {
    return fail(`cannot read ${file} as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (doc?.$schema !== CHANGE_SET_SCHEMA_ID || doc.contract !== CHANGE_SET_CONTRACT) {
    return fail(`${file} is not a change-set document: its $schema is not ${CHANGE_SET_SCHEMA_ID} with contract ${CHANGE_SET_CONTRACT}`);
  }

  const summary = groupChangeSet(doc);
  if (format === "json") console.log(JSON.stringify(summary, null, 2));
  else if (format === "markdown") process.stdout.write(renderPlanSummaryMarkdown(summary, { limit: args.limit ?? GITHUB_COMMENT_LIMIT }));
  else process.stdout.write(renderPlanSummaryText(summary));
  return 0;
}
