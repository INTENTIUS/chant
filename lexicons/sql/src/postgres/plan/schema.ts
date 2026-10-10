/**
 * The two sides a Postgres diff compares: a build's output (the
 * declarations), or what a live server's catalog prints. Both are parsed with
 * the tag each object was declared with and brought to canonical form
 * (`./normalize.ts`), so the diff compares like with like.
 */

import { readFileSync } from "node:fs";
import type { Keyed } from "../../core/diff";
import { previouslyIn } from "../../core/normalize";
import type { LivePgObject } from "../live/catalog";
import { liveProps } from "./deep";
import { canonicalPgObject, type CanonicalPgObject } from "./normalize";
import { identValue } from "../parser";

/** A canonical object with what the diff needs besides: rename hints, how an index is created, a view's outputs. */
export interface PgDiffObject extends CanonicalPgObject {
  type: string;
  /** `-- previously: <old name>` before the CREATE. */
  previously?: string;
  /** Per column, `-- previously: <old name>` on its line. */
  columnPreviously: Record<string, string>;
  /** The index is declared CONCURRENTLY. */
  concurrently?: boolean;
  /** A view's output columns, in order. */
  outputs?: string[];
  /** The tool another object belongs to (an ORM's revision table), when it is not chant's to change. */
  foreign?: string;
  /** The export name, against a server. */
  exportName?: string;
  /** What depends on a routine on the server (a view, a trigger, a default), which a DROP FUNCTION would refuse. */
  dependents?: string[];
}

export type PgSchemaObject = Keyed<PgDiffObject>;

/** The rename hints in a statement: the object's (a comment before the CREATE) and each column's (a comment on its line). */
export function renameHints(ddl: string): { previously?: string; columns: Record<string, string> } {
  const lines = ddl.split("\n");
  const createAt = lines.findIndex((l) => /\bCREATE\b/i.test(l.replace(/--.*$/, "")));
  const before = lines.slice(0, Math.max(createAt, 0)).map((l) => l.trim()).filter((l) => l.startsWith("--"));
  const columns: Record<string, string> = {};
  for (const line of lines.slice(createAt + 1)) {
    const m = /^\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\b.*?(--.*)$/.exec(line);
    if (!m) continue;
    const prev = previouslyIn([m[2]!]);
    if (prev) columns[identValue(m[1]!)] = identValue(prev);
  }
  const prev = previouslyIn(before);
  return { ...(prev ? { previously: prev } : {}), columns };
}

/** One object, from its type and statements, in the diff's form. */
export function diffObject(type: string, ddl: string, defaultSchema: string): PgDiffObject {
  const props = liveProps({ type, statement: ddl } as LivePgObject);
  const canonical = canonicalPgObject(type, props, defaultSchema);
  const hints = renameHints(ddl);
  const lineage = props.lineage as Array<{ output: string }> | undefined;
  const declaredColumns = props.columns as unknown[] | undefined;
  return {
    ...canonical,
    type,
    ...(hints.previously ? { previously: identValue(hints.previously) } : {}),
    columnPreviously: hints.columns,
    ...(props.concurrently === true ? { concurrently: true } : {}),
    ...(canonical.kind === "view" || canonical.kind === "materializedView"
      ? { outputs: Array.isArray(declaredColumns) && declaredColumns.length > 0 ? (declaredColumns as string[]) : (lineage ?? []).map((e) => e.output) }
      : {}),
  };
}

interface OutputDoc {
  dialect?: string;
  postgresMajor?: number;
  objects?: Array<{ export: string; type: string; ddl: string }>;
}

/** The objects a Postgres `chant build` output holds, keyed by export name. */
export function pgSchemaFromBuildOutput(json: string, defaultSchema = "public"): PgSchemaObject[] {
  const doc = JSON.parse(json) as OutputDoc;
  if (doc.dialect !== "postgres" || !Array.isArray(doc.objects)) throw new Error('not a Postgres build output: expected { dialect: "postgres", objects: [...] }');
  return doc.objects.map((o) => ({ key: o.export, canonical: { ...diffObject(o.type, o.ddl, defaultSchema), exportName: o.export } }));
}

/** The major a Postgres build recorded (`postgresMajor`), or undefined for output that predates the field. */
export function pgBuildMajor(json: string): number | undefined {
  const m = (JSON.parse(json) as OutputDoc).postgresMajor;
  return typeof m === "number" ? m : undefined;
}

export function pgBuildFileMajor(path: string): number | undefined {
  return pgBuildMajor(readFileSync(path, "utf-8"));
}

export function pgSchemaFromBuildFile(path: string, defaultSchema = "public"): PgSchemaObject[] {
  return pgSchemaFromBuildOutput(readFileSync(path, "utf-8"), defaultSchema);
}

/**
 * The namespace an object's name is unique in: relations (tables, views,
 * sequences, indexes) share one per schema, types and domains another,
 * functions and procedures a third (told apart by their parameter types),
 * a trigger's or a policy's name is unique on its table, and a role's in the
 * cluster.
 */
export function pgNamespace(kind: string): string {
  if (kind === "schema" || kind === "extension" || kind === "trigger" || kind === "policy" || kind === "role") return kind;
  if (kind === "grant" || kind === "defaultPrivileges") return "grant";
  if (kind === "enum" || kind === "domain") return "type";
  if (kind === "function" || kind === "procedure") return "routine";
  return "relation";
}

/** The identity an object has on a server: its kind's namespace, its qualified name, and its signature where it has one. */
export function qualifiedKey(o: { kind: string; schema?: string; name: string; signature?: string }): string {
  return `${pgNamespace(o.kind)} ${o.schema ? `${o.schema}.` : ""}${o.name}${o.signature ?? ""}`;
}

/** The declared objects re-keyed by qualified name, the only identity a server has. */
export function keyedByQualifiedName(objects: readonly PgSchemaObject[]): PgSchemaObject[] {
  return objects.map((o) => ({ key: qualifiedKey(o.canonical), canonical: { ...o.canonical, exportName: o.canonical.exportName ?? o.key } }));
}

/** What a server holds, in the diff's form, keyed by qualified name. */
export function pgSchemaFromLive(live: readonly LivePgObject[], defaultSchema: string): PgSchemaObject[] {
  // A routine with a SQL-standard body is not one a declaration can hold (`../parser.ts`): never chant's, never compared.
  return live.filter((o) => !o.unsupported).map((o) => {
    const canonical = {
      ...diffObject(o.type, o.statement, defaultSchema),
      ...(o.foreign ? { foreign: o.foreign } : {}),
      ...(o.dependents && o.dependents.length > 0 ? { dependents: o.dependents } : {}),
    };
    return { key: qualifiedKey(canonical), canonical };
  });
}
