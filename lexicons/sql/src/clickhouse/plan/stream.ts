/**
 * Stream engines (#4396): Kafka, S3Queue, AzureQueue, RabbitMQ, NATS and
 * FileLog. A table on one of them stores no rows. It is a consumer: the
 * materialized views that read it pull messages (or files) through it into a
 * target, and the position it has reached lives outside the table, in the
 * broker's committed offsets or in Keeper.
 *
 * What follows from that, and what this file holds:
 *
 * - There is no ALTER for the engine's arguments, and nothing to copy to a
 *   new table, so a change is neither `metadata` nor a `rebuild`: the table is
 *   replaced, with the views that read it detached around the replacement
 *   (SQLCH225, `./rules.ts`).
 * - A replacement can lose the table's position. The two changes that do
 *   are found here and reported on the change as a note.
 */

import type { CanonicalObject } from "./normalize";

/** The stream engines, as `system.tables.engine` names them. */
export const STREAM_ENGINES: ReadonlySet<string> = new Set(["Kafka", "S3Queue", "AzureQueue", "RabbitMQ", "NATS", "FileLog"]);

/** Whether an engine name is a stream engine. */
export const isStreamEngine = (engine: string | undefined): boolean => engine !== undefined && STREAM_ENGINES.has(engine);

/** Whether a canonical table is on a stream engine. */
export const isStreamTable = (o: CanonicalObject): boolean => o.kind === "table" && isStreamEngine(o.engineName);

/** The arguments inside an engine's parentheses, split at top-level commas, string quotes removed. Empty when it has none. */
export function streamEngineArguments(engine: string | undefined): string[] {
  const open = engine?.indexOf("(") ?? -1;
  if (engine === undefined || open < 0 || !engine.endsWith(")")) return [];
  const inner = engine.slice(open + 1, -1);
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\") cur += inner[++i] ?? "";
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((a) => (/^'.*'$/.test(a) ? a.slice(1, -1) : a));
}

/** Kafka's positional arguments, in the order the engine takes them. */
const KAFKA_POSITIONAL = ["kafka_broker_list", "kafka_topic_list", "kafka_group_name", "kafka_format"];

/** A Kafka setting, from SETTINGS or from the engine's positional arguments. */
function kafkaSetting(o: CanonicalObject, name: string): string | undefined {
  const at = KAFKA_POSITIONAL.indexOf(name);
  return o.settings[name] ?? (at >= 0 ? streamEngineArguments(o.engine)[at] : undefined);
}

/**
 * What a replacement would lose, in a sentence each (#4396):
 *
 * - a different `kafka_group_name` is a different consumer group: it starts
 *   from the group's committed offsets, or from the topic's start when the
 *   group has none (`auto.offset.reset`);
 * - a different S3Queue `keeper_path` is a different place for the table's
 *   record of processed files, so every file already seen is processed again.
 *
 * Neither is a refusal: a new group or path is sometimes the point.
 */
export function positionWarnings(before: CanonicalObject, after: CanonicalObject): string[] {
  const out: string[] = [];
  if (before.engineName === "Kafka" && after.engineName === "Kafka") {
    const b = kafkaSetting(before, "kafka_group_name");
    const a = kafkaSetting(after, "kafka_group_name");
    if (b !== a) {
      out.push(
        `kafka_group_name changes from ${b ?? "none"} to ${a ?? "none"}: the new group starts from its own committed offsets, or from the start of the topic when it has none, ` +
          "so messages already consumed may be read again or skipped",
      );
    }
  }
  if (before.engineName === "S3Queue" && after.engineName === "S3Queue") {
    const b = before.settings.keeper_path;
    const a = after.settings.keeper_path;
    if (b !== a) {
      out.push(
        `keeper_path changes from ${b ?? "none"} to ${a ?? "none"}: the new path holds no record of processed files, so every file already seen is processed again`,
      );
    }
  }
  return out;
}

/** Whether a materialized view reads from the table: its SELECT names the table, qualified or, in the table's own database, bare. */
export function readsTable(view: CanonicalObject, table: CanonicalObject): boolean {
  if (view.kind !== "materializedView" || view.select === undefined) return false;
  const escaped = table.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sameDatabase = view.database === table.database;
  const database = table.database?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The canonical SELECT drops the view's own database from a name, so a bare name is a table in the view's database.
  const names = [...(sameDatabase ? [escaped] : []), ...(database ? [`${database}\\s*\\.\\s*${escaped}`] : [])];
  return names.some((n) => new RegExp(`(?:^|[^\\w.])${n}(?![\\w.])`).test(view.select!));
}
