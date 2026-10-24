/**
 * The migration files a pull request adds to a migration-directory workspace
 * member (#4407), for the plan note. Reads the member's migrations at the
 * pull request's head with the kind's own reader (`./kind-link-readers.ts`),
 * keeps the files the base commit lacks, and asks a lexicon to classify
 * them (`LexiconPlugin.classifyMigrations`). It reads git objects and files
 * only: nothing is applied, no server is contacted, and no tool runs.
 */

import type { LexiconPlugin } from "../lexicon";
import type { MigrationFileClassification, PrMigrationFile } from "../pr-migrations";
import { readDeclaration } from "./declaration";
import { readKindLinks, type KindLinkRead, type KindReadMigration } from "./kind-link-readers";
import { loadKindRegistry } from "./kinds";
import type { WorkspaceTree } from "./tree";
import { locateWorkspace } from "./which-chant";

/** One member's new migrations. */
export interface NewMigrationGroup {
  member: string;
  /** The member's directory, tree-relative; "" for the workspace root. */
  dir: string;
  reader: string;
  dialect: string;
  /** The new files, in the order the tool applies them. */
  migrations: KindReadMigration[];
}

/**
 * Per member, the migrations whose file is not in `base`. An `undo` file is
 * not an up migration and is left out. With no `base` tree (the workspace did
 * not exist there) every migration is new. `only` limits the answer to one
 * member, for a member's own pipeline.
 */
export function newMigrationGroups(
  members: readonly { name: string; dir: string }[],
  read: ReadonlyMap<string, KindLinkRead>,
  base: WorkspaceTree | undefined,
  only?: string,
): NewMigrationGroup[] {
  const out: NewMigrationGroup[] = [];
  for (const m of members) {
    if (only !== undefined && m.name !== only) continue;
    const r = read.get(m.name);
    if (!r?.migrations) continue;
    const added = r.migrations.filter((mig) => mig.type !== "undo" && base?.stat(mig.file) !== "file");
    if (added.length === 0) continue;
    out.push({ member: m.name, dir: m.dir === "." ? "" : m.dir, reader: r.reader, dialect: added[0]!.dialect, migrations: added });
  }
  return out;
}

/**
 * Classify the new files with the first lexicon that answers each. A file no
 * lexicon answers for comes back with an `error` that says which dialect, so
 * the note shows it instead of leaving it out.
 */
export async function classifyNewMigrations(groups: readonly NewMigrationGroup[], head: WorkspaceTree, plugins: readonly Pick<LexiconPlugin, "name" | "classifyMigrations">[]): Promise<PrMigrationFile[]> {
  const out: PrMigrationFile[] = [];
  for (const g of groups) {
    const files = g.migrations.map((m) => m.file);
    const answers = new Map<string, MigrationFileClassification>();
    for (const p of plugins) {
      if (!p.classifyMigrations || answers.size === files.length) continue;
      const left = files.filter((f) => !answers.has(f));
      try {
        for (const a of await p.classifyMigrations({ reader: g.reader, dialect: g.dialect, tree: head, dir: g.dir, files: left })) answers.set(a.file, a);
      } catch (err) {
        for (const f of left) answers.set(f, { file: f, statements: [], error: `the ${p.name} lexicon could not classify it: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    for (const m of g.migrations) {
      const a = answers.get(m.file) ?? { file: m.file, statements: [], error: `no installed lexicon classifies ${g.dialect} migrations` };
      out.push({ member: g.member, reader: g.reader, version: m.version, name: m.name, type: m.type, dialect: m.dialect, ...a });
    }
  }
  return out;
}

/**
 * The new migration files of the workspace holding `cwd`, between `base` and
 * `head`. Empty outside a workspace or when the declaration cannot be read.
 */
export async function newMigrationFilesBetween(
  cwd: string,
  base: string,
  head: string,
  options: { member?: string; plugins: () => Promise<readonly Pick<LexiconPlugin, "name" | "classifyMigrations">[]> },
): Promise<PrMigrationFile[]> {
  let located;
  let declaration;
  try {
    located = locateWorkspace(cwd, head);
    declaration = readDeclaration(located.tree, "", { rootChant: true });
  } catch {
    return [];
  }
  const { registry } = loadKindRegistry(declaration.pins, located.rootOnDisk);
  const read = readKindLinks(declaration, located.tree, registry);
  let baseTree: WorkspaceTree | undefined;
  try {
    baseTree = locateWorkspace(cwd, base).tree;
  } catch {
    baseTree = undefined;
  }
  const groups = newMigrationGroups(declaration.members, read, baseTree, options.member);
  if (groups.length === 0) return [];
  return classifyNewMigrations(groups, located.tree, await options.plugins());
}
