/**
 * `chant sql diff` and `chant sql plan`: the classified change between two
 * builds, or between a build and a live server. A Postgres build (its output
 * says `"dialect": "postgres"`) or a Postgres binding goes to
 * `../../postgres/plan/commands.ts`.
 *
 *     chant sql diff <before.json> <after.json> [--json] [--statements] [--topology <topology>]
 *     chant sql plan <env> <build.json> [--json]
 *
 * `diff` is offline: it compares two `chant build` outputs, say a pull
 * request's base and head, and needs no server. `plan` compares a build with
 * the server `sql.profiles.<env>` binds and asks that server's formatter about
 * expressions the rules leave different. Both exit 2 when a change needs a
 * rebuild, which a plan refuses to make in place, and `plan` also when the
 * declared databases hold an object whose definition it cannot read (#3653),
 * which it names; 0 otherwise. For each
 * refused table they name the `ClickHouseRebuildOp` to run instead
 * (`rebuildOps` in `--json`, `./rebuild-handoff.ts`).
 *
 * `diff --statements` prints the statements instead, for a migration file:
 * each one the applier would send, with its change's rule and class, and a
 * refused change as the Op that makes it (`../../migration-statements.ts`).
 * The marker in each `CREATE` is the project's `ownership` config's.
 *
 * `--topology` (`single`, `cluster:<name>`, `replicated`, `replicated:<cluster>`,
 * `cloud`; `../topology.ts`) renders a ClickHouse diff's declarations and
 * statements for that topology: `ON CLUSTER` and the engine. `--statements`
 * renders for `single` without it; the plain diff compares the declarations as
 * written. `plan` takes the topology from `sql.profiles.<env>.topology`.
 */

import type { CommandGroup, CommandGroupContext } from "@intentius/chant/cli/command-group";
import { diffSchemas, type SchemaDiff, type UnreadableEntry } from "./diff";
import { renderDiff } from "./report";
import { keyedByQualifiedName, schemaFromBuildFile, schemaFromServer } from "./schema";
import { dropFormattingOnly } from "./server-format";
import { scopeOf } from "./normalize";
import { ACCESS_KINDS, accessUnmanagedHint, declaredAccess } from "../live/catalog";
import { bindClickHouse } from "../live/bind";
import { rebuildOpSuggestions } from "./rebuild-handoff";
import { readFileSync } from "node:fs";
import { parseTopology, type Topology } from "../topology";

/** The dialect a build output names. */
function outputDialect(path: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(path, "utf-8")) as { dialect?: string }).dialect;
  } catch {
    return undefined;
  }
}

interface DiffArgs {
  positional: string[];
  json: boolean;
  statements: boolean;
  /** `--topology <t>` or `--topology=<t>`, as written. */
  topology?: string;
}

function split(args: string[]): DiffArgs {
  const positional: string[] = [];
  let topology: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--topology") topology = args[++i] ?? "";
    else if (a.startsWith("--topology=")) topology = a.slice("--topology=".length);
    else if (!a.startsWith("--")) positional.push(a);
  }
  return { positional, json: args.includes("--json"), statements: args.includes("--statements"), ...(topology !== undefined ? { topology } : {}) };
}

/** `chant sql diff --statements`: the statements between two builds, as SQL with comments or as JSON. Exits 2 when a step is an Op or manual. */
async function runDiffStatements(before: string, after: string, json: boolean, topology: Topology | undefined): Promise<number> {
  const { diffStatements, renderStatements } = await import("../../migration-statements");
  const { resolveOwnershipMarker } = await import("../../core/apply");
  let marker;
  try {
    const { loadChantConfig } = await import("@intentius/chant/config");
    const config = await loadChantConfig(process.cwd()).then((r) => r.config).catch(() => undefined);
    marker = resolveOwnershipMarker({}, config, "chant sql diff --statements");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const doc = diffStatements(readFileSync(before, "utf-8"), readFileSync(after, "utf-8"), { ...(marker ? { marker } : {}), ...(topology ? { topology } : {}) });
  console.log(json ? JSON.stringify(doc, null, 2) : renderStatements(doc));
  return doc.refused ? 2 : 0;
}

function emit(diff: SchemaDiff, json: boolean, title: string): number {
  console.log(json ? JSON.stringify(diff, null, 2) : renderDiff(diff, { title }));
  return diff.rebuilds.length > 0 || (diff.unreadable?.length ?? 0) > 0 ? 2 : 0;
}

export async function runDiff(ctx: CommandGroupContext): Promise<number> {
  const { positional, json, statements, topology: topologyArg } = split(ctx.rawArgs);
  if (positional.length !== 2) {
    console.error("usage: chant sql diff <before.json> <after.json> [--json] [--statements] [--topology <topology>]");
    return 1;
  }
  let topology: Topology | undefined;
  try {
    topology = topologyArg !== undefined ? parseTopology(topologyArg) : undefined;
  } catch (err) {
    console.error(`--topology: ${(err as Error).message}`);
    return 1;
  }
  if (statements) return runDiffStatements(positional[0]!, positional[1]!, json, topology);
  if (outputDialect(positional[1]!) === "postgres") {
    const { diffPgBuildFiles, emitPg, projectMajor } = await import("../../postgres/plan/commands");
    return emitPg(diffPgBuildFiles(positional[0]!, positional[1]!, await projectMajor()), json, `${positional[0]} -> ${positional[1]}`);
  }
  const after = schemaFromBuildFile(positional[1]!, "default", topology);
  const diff = diffSchemas(schemaFromBuildFile(positional[0]!, "default", topology), after);
  const rebuildOps = rebuildOpSuggestions(diff, new Map(after.map((o) => [o.key, o.canonical])), "<env>");
  return emit(rebuildOps.length > 0 ? { ...diff, rebuildOps } : diff, json, `${positional[0]} -> ${positional[1]}`);
}

/** The declared objects against the server, keys and labels by `database.name`. */
export async function planAgainstServer(environment: string, buildFile: string, options: Parameters<typeof bindClickHouse>[0] = {}): Promise<SchemaDiff> {
  const target = await bindClickHouse({ ...options, environment });
  const all = keyedByQualifiedName(schemaFromBuildFile(buildFile, target.defaultDatabase, target.topology));
  // Access declarations a profile does not manage are not planned, and the server's access is not read (#3716).
  const declared = target.access === true ? all : all.filter((o) => !ACCESS_KINDS.has(o.canonical.kind));
  const unmanaged = all.length - declared.length;
  const databases = new Set(declared.map((o) => scopeOf(o.canonical)));
  const unreadable: UnreadableEntry[] = [];
  const live = await schemaFromServer(target, databases, unreadable, declaredAccess(declared.map((o) => o.canonical)));
  const diff = diffSchemas(live, declared);
  const changes = await dropFormattingOnly(target.endpoint, diff.changes);
  const rebuildOps = rebuildOpSuggestions(
    { ...diff, changes, rebuilds: changes.filter((c) => c.class === "rebuild") },
    new Map(declared.map((o) => [o.key, o.canonical])),
    environment,
  );
  const label = new Map(declared.map((o) => [o.key, o.exportName === o.key ? o.key : `${o.exportName} (${o.key})`]));
  const relabel = changes.map((c) => ({ ...c, object: label.get(c.object) ?? c.object }));
  return {
    changes: relabel,
    rebuilds: relabel.filter((c) => c.class === "rebuild"),
    hints: unmanaged > 0 ? [...diff.hints, accessUnmanagedHint(unmanaged, environment)] : diff.hints,
    ...(rebuildOps.length > 0 ? { rebuildOps } : {}),
    ...(unreadable.length > 0 ? { unreadable } : {}),
  };
}

export async function runPlan(ctx: CommandGroupContext): Promise<number> {
  const { positional, json } = split(ctx.rawArgs);
  if (positional.length !== 2) {
    console.error("usage: chant sql plan <env> <build.json> [--json]");
    return 1;
  }
  if (outputDialect(positional[1]!) === "postgres") {
    const { planPgAgainstServer, emitPg } = await import("../../postgres/plan/commands");
    return emitPg(await planPgAgainstServer(positional[0]!, positional[1]!), json, `${positional[1]} against ${positional[0]}`);
  }
  const diff = await planAgainstServer(positional[0]!, positional[1]!);
  return emit(diff, json, `${positional[1]} against ${positional[0]}`);
}

export const sqlCommands: CommandGroup = {
  name: "sql",
  description: "Schema changes, classified: between two builds, or a build and a live server",
  commands: [
    { name: "diff", description: "Classify the change between two chant build outputs (offline); --statements prints the statements it takes, --topology renders them for single, cluster:<name>, replicated or cloud", handler: runDiff },
    { name: "plan", description: "Classify the change from an environment's server to a chant build output", handler: runPlan },
  ],
};
