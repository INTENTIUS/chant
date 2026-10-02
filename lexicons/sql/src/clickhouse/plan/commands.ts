/**
 * `chant sql diff` and `chant sql plan`: the classified change between two
 * builds, or between a build and a live server.
 *
 *     chant sql diff <before.json> <after.json> [--json]
 *     chant sql plan <env> <build.json> [--json]
 *
 * `diff` is offline: it compares two `chant build` outputs, say a pull
 * request's base and head, and needs no server. `plan` compares a build with
 * the server `sql.profiles.<env>` binds and asks that server's formatter about
 * expressions the rules leave different. Both exit 2 when a change needs a
 * rebuild, which a plan refuses to make in place, and 0 otherwise.
 */

import type { CommandGroup, CommandGroupContext } from "@intentius/chant/cli/command-group";
import { diffSchemas, type SchemaDiff } from "./diff";
import { renderDiff } from "./report";
import { keyedByQualifiedName, schemaFromBuildFile, schemaFromServer } from "./schema";
import { dropFormattingOnly } from "./server-format";
import { bindClickHouse } from "../live/bind";

function split(args: string[]): { positional: string[]; json: boolean } {
  return { positional: args.filter((a) => !a.startsWith("--")), json: args.includes("--json") };
}

function emit(diff: SchemaDiff, json: boolean, title: string): number {
  console.log(json ? JSON.stringify(diff, null, 2) : renderDiff(diff, { title }));
  return diff.rebuilds.length > 0 ? 2 : 0;
}

export async function runDiff(ctx: CommandGroupContext): Promise<number> {
  const { positional, json } = split(ctx.rawArgs);
  if (positional.length !== 2) {
    console.error("usage: chant sql diff <before.json> <after.json> [--json]");
    return 1;
  }
  const diff = diffSchemas(schemaFromBuildFile(positional[0]!), schemaFromBuildFile(positional[1]!));
  return emit(diff, json, `${positional[0]} -> ${positional[1]}`);
}

/** The declared objects against the server, keys and labels by `database.name`. */
export async function planAgainstServer(environment: string, buildFile: string, options: Parameters<typeof bindClickHouse>[0] = {}): Promise<SchemaDiff> {
  const target = await bindClickHouse({ ...options, environment });
  const declared = keyedByQualifiedName(schemaFromBuildFile(buildFile, target.defaultDatabase));
  const databases = new Set(declared.map((o) => o.canonical.database ?? o.canonical.name));
  const live = await schemaFromServer(target, databases);
  const diff = diffSchemas(live, declared);
  const changes = await dropFormattingOnly(target.endpoint, diff.changes);
  const label = new Map(declared.map((o) => [o.key, `${o.exportName} (${o.key})`]));
  const relabel = changes.map((c) => ({ ...c, object: label.get(c.object) ?? c.object }));
  return { changes: relabel, rebuilds: relabel.filter((c) => c.class === "rebuild"), hints: diff.hints };
}

export async function runPlan(ctx: CommandGroupContext): Promise<number> {
  const { positional, json } = split(ctx.rawArgs);
  if (positional.length !== 2) {
    console.error("usage: chant sql plan <env> <build.json> [--json]");
    return 1;
  }
  const diff = await planAgainstServer(positional[0]!, positional[1]!);
  return emit(diff, json, `${positional[1]} against ${positional[0]}`);
}

export const sqlCommands: CommandGroup = {
  name: "sql",
  description: "Schema changes, classified: between two builds, or a build and a live server",
  commands: [
    { name: "diff", description: "Classify the change between two chant build outputs (offline)", handler: runDiff },
    { name: "plan", description: "Classify the change from an environment's server to a chant build output", handler: runPlan },
  ],
};
