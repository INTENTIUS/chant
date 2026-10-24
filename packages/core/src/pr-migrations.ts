/**
 * The migration files a pull request adds, classified for the plan note
 * (#4407). This is the "check" adoption level: each new migration in a
 * migration-directory workspace member (goose, golang-migrate,
 * clickhouse-migrations, Flyway) is read offline and its statements are given
 * the class the lexicon's classifier gives the same change. Nothing is applied
 * and no server is contacted.
 *
 * Core holds the shapes and the note's lines. The classes come from a
 * lexicon's `classifyMigrations` (`./lexicon.ts`), the way a lexicon's
 * `classifyDisruption` supplies the disruption of an update. Pure: it imports
 * nothing, so `./pr-loop.ts` can render it.
 */

/** One change a statement makes, under one classifier rule. */
export interface MigrationChange {
  rule: string;
  /** The rule's class, e.g. `rebuild`, `concurrently`, `metadata`. */
  class: string;
  /** The class as a report names it, e.g. `REBUILD`. */
  label: string;
  title: string;
  /** Postgres: the lock the rule names. */
  lock?: string;
  destructive?: boolean;
  note?: string;
}

/** What one statement came to: `undecided` lists `candidates`; `unclassified` and `data` say why in `note`. */
export interface MigrationStatement {
  /** 1-based position among the file's up statements. */
  index: number;
  /** The statement's first line, cut to 120 characters. */
  sql: string;
  outcome: "classified" | "undecided" | "unclassified" | "data";
  changes: MigrationChange[];
  candidates?: MigrationChange[];
  note?: string;
}

/** What a lexicon answers for one new migration file. */
export interface MigrationFileClassification {
  /** The file, relative to the workspace root. */
  file: string;
  statements: MigrationStatement[];
  /** Set when the file could not be read (a Flyway placeholder with no value): why. */
  error?: string;
}

/** A new migration file in the report's `migrations`. */
export interface PrMigrationFile extends MigrationFileClassification {
  /** The workspace member whose directory holds it. */
  member: string;
  /** The reader that listed it: `goose-dir`, `golang-migrate-dir`, `clickhouse-migrations-dir` or `flyway-dir`. */
  reader: string;
  version: string;
  name: string;
  type: "versioned" | "repeatable" | "baseline" | "undo";
  dialect: string;
}

/** One line of plain text: the report is read from a file the head's job wrote, so nothing in it breaks the note's layout. */
const line = (s: string): string => s.replace(/\s+/g, " ").trim();

const code = (s: string): string => `\`${line(s).replace(/`/g, "'")}\``;

const changeText = (c: MigrationChange): string => `${c.label} (${c.rule}${c.lock ? `, ${c.lock}` : ""})${c.destructive ? ", removes data" : ""}`;

/** The statement's row in the note. */
function statementText(s: MigrationStatement): string {
  if (s.outcome === "classified") return s.changes.map(changeText).join("; ") + (s.note ? `. ${line(s.note)}` : "");
  if (s.outcome === "undecided") {
    const decided = s.changes.length > 0 ? `${s.changes.map(changeText).join("; ")}; ` : "";
    return `${decided}undecided between ${(s.candidates ?? []).map((c) => `${c.rule} ${c.label}`).join(" and ")}${s.note ? `: ${line(s.note)}` : ""}`;
  }
  if (s.outcome === "unclassified") return `no class${s.note ? `: ${line(s.note)}` : ""}`;
  return `data, not schema${s.note ? `: ${line(s.note)}` : ""}`;
}

/**
 * The note's section: one heading line per new file and a list of its
 * statements with their classes. Empty when the pull request adds none.
 */
export function renderMigrationLines(files: readonly PrMigrationFile[] | undefined): string[] {
  if (!files || files.length === 0) return [];
  const out: string[] = ["", `New migration files (${files.length}), classified offline. Nothing is applied and no server is contacted.`];
  for (const f of files) {
    out.push("", `${code(f.file)} (member ${code(f.member)}, ${f.dialect}${f.type === "versioned" ? "" : `, ${f.type}`})`);
    if (f.error) {
      out.push(`- not read: ${line(f.error)}`);
      continue;
    }
    if (f.statements.length === 0) out.push("- no up statements");
    for (const s of f.statements) out.push(`- ${s.index}. ${code(s.sql)}: ${statementText(s)}`);
  }
  return out;
}
