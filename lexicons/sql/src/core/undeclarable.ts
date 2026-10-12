/**
 * Objects an import finds that no declaration can hold (#3911).
 *
 * Import reads every kind of object the server has, not only the kinds chant
 * declares, so none is left out without a word. An object of a kind the
 * coverage table marks refused (`../coverage.ts`) is collected here, and the
 * import fails naming every one of them at once: kind, schema and name.
 * `--skip-undeclarable` imports the rest and lists them as warnings instead,
 * so an adopter is not stuck behind an aggregate they mean to keep by hand.
 */

import { kindRow } from "../coverage";
import type { SqlDialect } from "../dialects";

/** One object of a kind chant cannot declare. */
export interface UndeclarableObject {
  /** The coverage table's kind: `aggregate`, `composite type`. */
  kind: string;
  /** The Postgres schema or ClickHouse database it is in; absent for a database-wide or server-wide object. */
  schema?: string;
  /** Its name, with what identifies it besides: an aggregate's argument types, a rule's table, a cast's types. */
  name: string;
  /** The role or user that owns it, where that tells a managed provider's own object from the database owner's. */
  owner?: string;
}

/** `aggregate app.total(integer)`. */
export const describeUndeclarable = (o: UndeclarableObject): string => `${o.kind} ${o.schema ? `${o.schema}.` : ""}${o.name}`;

const DOCS = "https://intentius.io/chant/lexicons/sql/object-coverage/";

/** The import's refusal: every undeclarable object, then why for each kind among them. */
export class UndeclarableObjectsError extends Error {
  constructor(
    readonly dialect: SqlDialect,
    readonly objects: readonly UndeclarableObject[],
  ) {
    const kinds = [...new Set(objects.map((o) => o.kind))];
    const n = objects.length;
    super(
      [
        `the ${dialect === "postgres" ? "Postgres" : "ClickHouse"} server has ${n === 1 ? "an object" : `${n} objects`} of a kind chant cannot declare, so the import would leave ${n === 1 ? "it" : "them"} out:`,
        ...objects.map((o) => `  - ${describeUndeclarable(o)}`),
        "Why, by kind:",
        ...kinds.map((k) => `  - ${k}: ${kindRow(dialect, k).reason ?? "not declared"}`),
        `To import everything else and list ${n === 1 ? "it" : "these"} as warnings, run the import again with --skip-undeclarable. Which kinds chant declares: ${DOCS}`,
      ].join("\n"),
    );
    this.name = "UndeclarableObjectsError";
  }
}

/** One warning per object, for `--skip-undeclarable`. */
export function undeclarableWarnings(dialect: SqlDialect, objects: readonly UndeclarableObject[]): string[] {
  return objects.map((o) => `${describeUndeclarable(o)} is left out (--skip-undeclarable): ${kindRow(dialect, o.kind).reason ?? "chant cannot declare it"}`);
}

/**
 * Refuse the import when it found undeclarable objects, or, with `skip`,
 * add a warning per object to `warnings`. Nothing found is nothing to do.
 */
export function refuseUndeclarable(dialect: SqlDialect, objects: readonly UndeclarableObject[], skip: boolean | undefined, warnings: string[]): void {
  if (objects.length === 0) return;
  if (!skip) throw new UndeclarableObjectsError(dialect, objects);
  warnings.push(...undeclarableWarnings(dialect, objects));
}
