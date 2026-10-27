/**
 * `chant index <substrate>` as a registry command (chant#4532).
 *
 * At the terminal, main() hands `index`'s raw argv straight to
 * `runCloudIndex` (../../lifecycle/cloud-index.ts), because its flags are its
 * own. This entry is for a caller that has already parsed a command line
 * with core's parser (the ACP server asks the registry whether a word is a
 * verb): it rebuilds the words that parser keeps (the substrate, `--json`,
 * `--help`), and refuses when the parsed line carried an action flag core's
 * parser knows, so the read-only rule holds on this path too.
 */
import type { CommandContext } from "../registry";

export async function runIndexCommand(ctx: CommandContext): Promise<number> {
  const { runCloudIndex } = await import("../../lifecycle/cloud-index");
  const a = ctx.args;
  const action = a.fix ? "--fix" : a.live ? "--live" : a.write ? "--write" : a.yes ? "--yes" : a.op ? "--op" : undefined;
  const words = [...(a.positionals ?? (a.path && a.path !== "." ? [a.path] : []))];
  if (action) words.push(action);
  if (a.json) words.push("--json");
  if (a.help) words.push("--help");
  return runCloudIndex(words);
}
