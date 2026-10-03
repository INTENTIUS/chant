/**
 * How a plan hands a change it refuses to make in place to a migration Op,
 * the same in every dialect.
 *
 * `chant sql plan`, `chant sql diff` and the applier refuse a change the
 * dialect cannot make in place (a ClickHouse sorting-key change, which needs
 * a rebuild). What they hand on is the Op to run instead, one per object: a
 * declaration ready to put in an `*.op.ts` file, reviewed in the pull request
 * like the schema change it carries out. Nothing is written for the user. The
 * Op's own Plan phase classifies the change again against the server.
 *
 * Which Op, and the options a dialect suggests for it (ClickHouse's dual-write
 * mode), are the dialect's.
 */

/** One Op to run instead of a refused change. A dialect adds its own suggested options. */
export interface MigrationOpSuggestion {
  /** The object the Op migrates, qualified as the dialect writes it. */
  table: string;
  /** The Op's suggested name. */
  name: string;
  env: string;
  /** The declaration, ready to paste into an `*.op.ts` file. */
  declaration: string;
}

/** An Op name for a migration of `table`: `<kind>-<table>`, lower case, runs of other characters as `-`. */
export function migrationOpName(kind: string, table: string): string {
  return `${kind}-${table.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`;
}

/**
 * The suggestions as report lines: what the Op is, the import it comes from,
 * then one declaration per line.
 */
export function renderMigrationOps(ops: readonly MigrationOpSuggestion[], op: { what: string; exportName: string; importPath: string }): string[] {
  if (ops.length === 0) return [];
  return [
    "",
    `Run ${ops.length === 1 ? "it" : "each"} as ${op.what}, declared in an *.op.ts file ` +
      `(import { ${op.exportName} } from "${op.importPath}"), then \`chant run <name>\` until it is done:`,
    ...ops.map((o) => `  ${o.declaration}`),
  ];
}
