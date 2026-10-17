import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CHANGE_SET_CONTRACT, CHANGE_SET_SCHEMA_ID, type ChangeSetDocument } from "../../change-set";
import { GITHUB_COMMENT_LIMIT, groupChangeSet, renderPlanSummaryMarkdown, renderPlanSummaryText } from "../../plan-summary";
import { formatError, formatWarning } from "../format";
import type { CommandContext } from "../registry";

const USAGE = "chant change-set summary <change-set.json> [--format text|json|markdown] [--limit <chars>]";
const SHOW_USAGE = "chant change-set show <digest> [--member <name>] [--json]";

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

/**
 * `chant change-set show <digest>` (#4022): the change-set document a gate
 * bound, stored on `chant/lifecycle` under its digest, with each entry's
 * graph node. `--json` prints the read contract's `change-set-show`
 * document (`../../workspace/change-set-show.ts`); without it, the grouped
 * summary and each entry with its node. `--member` reads a workspace
 * member's ledger from anywhere in the checkout. Exit 1 when nothing is
 * stored under the digest.
 */
export async function runChangeSetShow(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const digest = args.extraPositional;
  const { changeSetShowDocument, CHANGE_SET_DIGEST_PATTERN } = await import("../../workspace/change-set-show");
  if (!digest || !CHANGE_SET_DIGEST_PATTERN.test(digest)) {
    console.error(formatError({ message: digest ? `${digest} is not a change-set digest` : "change-set show needs the digest a gate binds", hint: SHOW_USAGE }));
    return 1;
  }
  if ((args.members?.length ?? 0) > 1) {
    console.error(formatError({ message: `change-set show reads one member, not ${args.members!.join(", ")}`, hint: SHOW_USAGE }));
    return 1;
  }
  const member = args.members?.[0]?.split("/").filter(Boolean);
  const doc = await changeSetShowDocument({ cwd: resolve("."), digest, ...(member ? { member } : {}) });
  if (args.json) {
    console.log(JSON.stringify(doc, null, 2));
    return "error" in doc || doc.changeSet === null ? 1 : 0;
  }
  if ("error" in doc) {
    console.error(formatError({ message: doc.error.message, hint: SHOW_USAGE }));
    return 1;
  }
  if (doc.reason) console.error(formatWarning({ message: doc.reason.message }));
  if (doc.changeSet === null) {
    if (!doc.reason) console.error(formatError({ message: `no change set is stored under ${digest}${doc.member ? ` for member ${doc.member}` : ""}`, hint: "A pull-request or release gate stores the change set it binds; a component gate binds a lifecycle plan and stores none." }));
    return 1;
  }
  process.stdout.write(renderPlanSummaryText(groupChangeSet(doc.changeSet)));
  const graph = doc.changeSet.graph;
  console.log(graph ? `\nNodes from the graph of ${graph.member ?? "this project"}${graph.at ? ` at ${graph.at.slice(0, 12)}` : ""}:` : "\nNo graph was read, so no entry has a node.");
  for (const e of doc.changeSet.entries) {
    if (e.action === "no-op" || e.action === "read") continue;
    console.log(`  ${e.action.padEnd(8)} ${e.member}  ${e.address}${e.deposed ? ` (deposed ${e.deposed})` : ""}  ${e.node ?? "(no node)"}`);
  }
  return 0;
}
