/**
 * Links a kind reads from its member's own files (#3932).
 *
 * A member's links usually come from its entry in `chant.workspace.json`, or
 * are inferred from a chant member's parameters by `joinKey()`. Some members
 * already say what they read in files of their own: a dbt project names the
 * tables it reads in its `sources:` YAML. A kind can name a link reader in its
 * kinds file (`reader`), and chant runs that reader over the member's
 * directory to derive the member's links.
 *
 * The readers are chant's code, listed in {@link KIND_LINK_READERS}: a kinds
 * file stays data, and chant never imports the package that supplies it. A
 * reader runs offline and parses files as data. It never invokes the tool
 * whose files it reads, so `chant workspace check` keeps its promise of no
 * network and no member code.
 *
 * A reader returns links with the file and line that state them, and gaps:
 * the places it could not read without guessing, such as a templated value.
 * `resolveLinks` (`./links.ts`) resolves the links beside the declared ones,
 * with origin `kind-reader`; WSP093 and WSP094 name the reader's file and line,
 * and WSP099 reports the gaps.
 *
 * A migration directory's reader (#4400) lists its migrations in order, in
 * {@link KindLinkRead.migrations}, and returns no links: what the migrations
 * produce comes from a replay.
 *
 * A reader may also return outputs (#3935): names the member's files state,
 * which other members link to. A dbt project's models are outputs, read the
 * same way as its sources. `resolveLinks` adds them to the member's handles
 * (`withReaderOutputs`), so a link to one resolves, and goes missing when the
 * file that states it is gone.
 */

import type { Declaration, Member } from "./declaration";
import { resolveMemberFields, type FieldValue, type KindLinkReaderName, type KindRegistry } from "./kinds";
import type { WorkspaceTree } from "./tree";
import { readDbtProject } from "./dbt-project-reader";
import { readClickHouseMigrationsDir, readGolangMigrateDir, readGooseDir } from "./migration-dirs";
import { readFlywayDir } from "./flyway-dir";

/** One link a reader found in the member's files. */
export interface KindReadLink {
  /**
   * The producer the link names, or null when the member's files don't say
   * which member produces it. A null producer is found among the members
   * whose outputs include {@link anchor}; see `resolveLinks`.
   */
  member: string | null;
  /** The producer's output the link reads. */
  output: string;
  /**
   * The output that picks the producer when `member` is null; unset, the
   * output itself. A dbt source column is anchored on its table, so a dropped
   * column is missing from the member that still has the table.
   */
  anchor?: string;
  /** The file that states the link, relative to the workspace root. */
  file: string;
  /** Its line, from 1. */
  line: number;
}

/** A place the reader could not read without guessing. The links it would have stated are left out. */
export interface KindReadGap {
  /** Relative to the workspace root. */
  file: string;
  line: number;
  message: string;
  /**
   * True when the gap leaves an output out of {@link KindLinkRead.outputs}
   * (#3935): a link to a name the member does not list is then unresolved,
   * not missing.
   */
  outputs?: boolean;
}

/** One output a reader found in the member's files: a name other members may link to. */
export interface KindReadOutput {
  name: string;
  /** The file that states it, relative to the workspace root. */
  file: string;
  /** Its line, from 1. */
  line: number;
}

/**
 * One migration a migration-directory reader found (#4400), in the order the
 * tool applies it. The reader lists files and never runs the tool, so the
 * schema the migrations produce comes from a replay, not from here.
 */
export interface KindReadMigration {
  /** 1-based position in the order the tool applies the migrations. */
  position: number;
  /** The version as the file name writes it, such as `00002`, `20240101120000` or `1.2`. */
  version: string;
  name: string;
  /** `versioned` runs once; `repeatable` runs again when its checksum changes (Flyway); `baseline` and `undo` are Flyway's B and U files. */
  type: "versioned" | "repeatable" | "baseline" | "undo";
  /** The file with the up statements, relative to the workspace root. */
  file: string;
  /** The line the up statements start on, from 1. */
  line: number;
  /** The file that undoes it, or true when the same file does (goose), or false when none does. */
  down: string | boolean;
  /** The SQL dialect the migration is written in: the member's `dialect` field, or what the directory's own configuration names. */
  dialect: string;
  /** False when the file asks to run outside a transaction (`-- +goose NO TRANSACTION`). */
  transaction?: boolean;
}

export interface KindLinkRead {
  /** The reader that ran: a kind's reader, or `lexicon <name>` for links a member's lexicon read from its declarations (#4397). */
  reader: KindLinkReaderName | `lexicon${string}`;
  links: KindReadLink[];
  gaps: KindReadGap[];
  /**
   * The outputs the member exposes that its files state (#3935), beside the
   * ones its kind lists. `resolveLinks` adds them to the member's handles, so
   * another member can link to them. A gap flagged `outputs` makes the list
   * incomplete.
   */
  outputs?: KindReadOutput[];
  /**
   * The member field that names the producer, for messages that ask the
   * author to set it when the files don't say (`sqlMember` for dbt).
   */
  producerField?: string;
  /** The migrations of a migration directory (#4400), in the order they apply; unset for other readers. */
  migrations?: KindReadMigration[];
}

/** What a reader gets: the member, its directory and resolved fields, and the tree read. */
export interface KindReaderInput {
  member: Member;
  /** The member's directory, tree-relative; "" for the workspace root. */
  dir: string;
  /** The member's fields, defaults filled in (#3151); null when its kind declares none. */
  fields: Record<string, FieldValue | null | Record<string, FieldValue | null>> | null;
  tree: WorkspaceTree;
}

export type KindLinkReader = (input: KindReaderInput) => KindLinkRead;

/** Every reader chant ships, by the name a kinds file uses. */
export const LINK_READERS: Record<KindLinkReaderName, KindLinkReader> = {
  "dbt-project": readDbtProject,
  "goose-dir": readGooseDir,
  "golang-migrate-dir": readGolangMigrateDir,
  "clickhouse-migrations-dir": readClickHouseMigrationsDir,
  "flyway-dir": readFlywayDir,
};

/**
 * Run the link reader of every member whose kind has one. A member whose
 * directory is missing is left out. A reader that throws is reported as a
 * gap on the member's directory, so one unreadable project never stops
 * the check.
 */
export function readKindLinks(declaration: Declaration, tree: WorkspaceTree, kinds: KindRegistry): Map<string, KindLinkRead> {
  const out = new Map<string, KindLinkRead>();
  for (const m of declaration.members) {
    const kind = kinds.get(m.kind);
    if (!kind?.reader) continue;
    const dir = m.dir === "." ? "" : m.dir;
    if (tree.stat(dir) !== "dir") continue;
    const { fields } = resolveMemberFields(kind, m.fields);
    try {
      out.set(m.name, LINK_READERS[kind.reader]({ member: m, dir, fields, tree }));
    } catch (err) {
      out.set(m.name, { reader: kind.reader, links: [], gaps: [{ file: dir || ".", line: 1, message: `the ${kind.reader} reader failed: ${(err as Error).message}`, outputs: true }] });
    }
  }
  return out;
}
