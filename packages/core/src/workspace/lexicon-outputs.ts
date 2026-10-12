/**
 * The outputs a member's lexicons report about their own declarations
 * (#3931), read offline for `chant workspace check`.
 *
 * A sql member exposes each table and each column as a workspace output
 * (`public.orders`, `public.orders.customer_id`) without anyone writing
 * `output(...)`. The names are the lexicon's to give, so the lexicon answers
 * through its `workspaceOutputs` hook, the way a CI lexicon answers
 * `graphEdges` (#3910).
 *
 * The check never runs member code. The member's source files are folded
 * with `foldProject` under `sandbox`, which evaluates the fold subset and
 * imports nothing from the project: a sql `table` template becomes the real
 * entity because the tag is the lexicon's own function, called with the
 * folded parts. A file that does not fold is not run either. It is handed to
 * the hook as unread, and when it is one of that lexicon's files (it uses the
 * lexicon's tags), the hook records a gap: the member's outputs are then
 * incomplete, and a link to a name not in them is unresolved rather than
 * missing.
 *
 * Folding is asynchronous and the checks are not, so the outputs are
 * gathered before the checks run, only for the members some declared link
 * targets, and only for the kinds whose outputs are read from source.
 *
 * Under `--at` the revision's files are not on disk to fold, so a member
 * whose lexicons report outputs gets a gap instead.
 */

import { join } from "node:path";
import type { Declarable } from "../declarable";
import type { LexiconUnreadSource, LexiconWorkspaceOutput } from "../graph-ir";
import type { BuildRootContext, BuildRootContribution, IntrinsicDef } from "../lexicon";
import type { Declaration, ResolvedGroup } from "./declaration";
import type { KindRegistry } from "./kinds";
import { kindHandles } from "./links";
import { readKindLinks } from "./kind-link-readers";
import { memberExcludes, sourceFiles } from "./member-handles";
import { memberDirOnDisk } from "./lexicon-symbols";
import type { WorkspaceTree } from "./tree";

/** What one member's lexicons report: its outputs, and why the list may be incomplete. */
export interface MemberLexiconOutputs {
  outputs: Pick<LexiconWorkspaceOutput, "name" | "previously">[];
  gaps: string[];
}

/** The part of a lexicon plugin this reader uses. */
export interface OutputsPlugin {
  name?: string;
  intrinsics?: () => IntrinsicDef[];
  buildRoots?: (ctx: BuildRootContext) => Promise<BuildRootContribution>;
  workspaceOutputs?: (entities: ReadonlyMap<string, Declarable>, unread?: readonly LexiconUnreadSource[]) => { outputs: LexiconWorkspaceOutput[]; gaps?: string[] } | undefined;
}

/** Loads a lexicon plugin by name; `loadPlugin` from the CLI unless a test swaps it. */
export type OutputsPluginLoader = (name: string) => Promise<OutputsPlugin>;

export interface GatherLexiconOutputsOptions {
  /** Read under `--at`: the member's files are a revision's, not on disk, so nothing is folded. */
  atRevision?: boolean;
  load?: OutputsPluginLoader;
}

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0];

const memberDir = (dir: string) => (dir === "." ? "" : dir);

/**
 * The lexicon names a member's config declares, read without running it.
 * Unlike the intent walk, a config that can't be read statically is not
 * loaded: the check runs no member code, so it is a gap.
 */
async function staticMemberLexicons(dir: string): Promise<string[]> {
  const { readLexiconDeclarationsStatically } = await import("../config-static");
  const read = readLexiconDeclarationsStatically(dir);
  if (read.status === "no-config") return [];
  if (read.status !== "read") throw new Error(read.reason);
  const { lexiconNames, registerLexiconDeclarations } = await import("../lexicon-module");
  const { dirname } = await import("node:path");
  registerLexiconDeclarations(read.entries, dirname(read.configPath));
  return lexiconNames(read.entries);
}

/**
 * The lexicon outputs of every member a declared link, or a link a kind's
 * reader found (#3932), targets, keyed by
 * member name. A member whose lexicons report nothing is left out.
 * `tree` is the working tree under `root`.
 */
export async function gatherLexiconOutputs(
  root: string,
  declaration: Declaration,
  tree: WorkspaceTree,
  groups: readonly ResolvedGroup[],
  kinds: KindRegistry,
  options: GatherLexiconOutputsOptions = {},
): Promise<Map<string, MemberLexiconOutputs>> {
  const out = new Map<string, MemberLexiconOutputs>();
  const targets = new Set(declaration.members.flatMap((m) => m.links.filter((l) => l.member !== m.name).map((l) => l.member)));
  // Links a kind's reader finds in a member's files target members too (#3932). One that names no
  // producer may be any other member's, so every other member is read.
  for (const [consumer, read] of readKindLinks(declaration, tree, kinds)) {
    for (const link of read.links) {
      if (link.member !== null) targets.add(link.member);
      else for (const m of declaration.members) if (m.name !== consumer) targets.add(m.name);
    }
  }
  for (const m of declaration.members) {
    if (!targets.has(m.name)) continue;
    const kind = kinds.get(m.kind);
    if (!kind || kindHandles(m, kind) || tree.stat(memberDir(m.dir)) !== "dir") continue;
    const read = await readMemberLexiconOutputs(root, declaration, tree, groups, m, options);
    if (read) out.set(m.name, read);
  }
  return out;
}

/** The lexicons the files import, by the package name chant gives a lexicon. */
function importedLexicons(tree: WorkspaceTree, files: readonly string[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    let text: string;
    try {
      text = tree.read(file);
    } catch {
      continue;
    }
    for (const m of text.matchAll(/from\s+["']@intentius\/chant-lexicon-([a-z0-9-]+)(?:\/[^"']*)?["']/g)) names.add(m[1]!);
  }
  return [...names].sort();
}

async function readMemberLexiconOutputs(
  root: string,
  declaration: Declaration,
  tree: WorkspaceTree,
  groups: readonly ResolvedGroup[],
  m: Declaration["members"][number],
  options: GatherLexiconOutputsOptions,
): Promise<MemberLexiconOutputs | undefined> {
  const dir = memberDirOnDisk(root, m.dir);
  const files = sourceFiles(tree, memberDir(m.dir), memberExcludes(declaration, groups, m));
  let names: string[];
  try {
    names = await staticMemberLexicons(dir);
  } catch {
    // A config that can't be read statically is not run. The lexicons the
    // source imports stand in for the ones it names.
    names = importedLexicons(tree, files);
  }
  if (names.length === 0) return undefined;
  const load = options.load ?? ((await import("../cli/plugins")).loadPlugin as unknown as OutputsPluginLoader);
  const plugins: { name: string; plugin: OutputsPlugin }[] = [];
  const gaps: string[] = [];
  for (const name of names) {
    try {
      plugins.push({ name, plugin: await load(name) });
    } catch (err) {
      gaps.push(`lexicon "${name}" could not be loaded, so the outputs it reads were not (${firstLine(err)})`);
    }
  }
  const reporting = plugins.filter((p) => typeof p.plugin.workspaceOutputs === "function");
  if (reporting.length === 0) return gaps.length ? { outputs: [], gaps } : undefined;
  if (options.atRevision) {
    return { outputs: [], gaps: [`the outputs of lexicon ${reporting.map((p) => p.name).join(", ")} are read from the working tree's files, not a revision's`] };
  }

  // Fold the member's source, never run it.
  const abs = (file: string) => join(root, ...file.split("/"));
  const intrinsics = plugins.flatMap((p) => {
    try {
      return p.plugin.intrinsics?.() ?? [];
    } catch {
      return [];
    }
  });
  let entities: Map<string, Declarable> = new Map();
  const unread: LexiconUnreadSource[] = [];
  try {
    const { foldProject } = await import("../discovery/fold-import");
    const { collectEntities } = await import("../discovery/collect");
    const verdicts = await foldProject(files.map(abs), intrinsics, { lexicons: names, sandbox: true });
    const folded: { file: string; exports: Record<string, unknown> }[] = [];
    for (const file of files) {
      const v = verdicts.get(abs(file));
      if (v?.verdict === "fold" && v.exports) {
        folded.push({ file: abs(file), exports: Object.fromEntries(v.exports) });
        continue;
      }
      let text = "";
      try {
        text = tree.read(file);
      } catch {
        // An unreadable file is still unread; the hook decides whether it matters.
      }
      const reason = v?.reason ?? (v?.taintedBy ? `it imports ${v.taintedBy.from}, which does not fold` : "it does not fold");
      unread.push({ file, text, reason });
    }
    entities = collectEntities(folded, dir);
  } catch (err) {
    return { outputs: [], gaps: [...gaps, `${m.dir}: its source could not be folded, so its lexicons' outputs were not read (${firstLine(err)})`] };
  }

  // A reporting lexicon's own build roots (the sql lexicon's `.sql` files) join
  // the folded entities, as they join a build's. Only these lexicons' hooks
  // run: they read files, and start nothing.
  for (const { name, plugin } of reporting) {
    if (typeof plugin.buildRoots !== "function") continue;
    const { readConfigFieldsStatically } = await import("../config-static");
    const read = readConfigFieldsStatically(dir, [name, "sourceDir"]);
    const config = read.status === "read" ? read.fields : {};
    const sourceDir = typeof config.sourceDir === "string" ? join(dir, config.sourceDir) : undefined;
    try {
      const contributed = await plugin.buildRoots({ projectRoot: dir, config, entities, ...(sourceDir ? { sourceDir } : {}) });
      for (const [key, entity] of contributed.entities) if (!entities.has(key)) entities.set(key, entity);
    } catch (err) {
      gaps.push(`lexicon "${name}" could not read the member's other source files, so their declarations were not read (${firstLine(err)})`);
    }
  }

  const outputs: MemberLexiconOutputs["outputs"] = [];
  for (const { name, plugin } of reporting) {
    try {
      const report = plugin.workspaceOutputs!(entities, unread);
      if (!report) continue;
      for (const o of report.outputs) outputs.push({ name: o.name, ...(o.previously?.length ? { previously: o.previously } : {}) });
      for (const g of report.gaps ?? []) gaps.push(g);
    } catch (err) {
      gaps.push(`lexicon "${name}" workspaceOutputs threw, so its outputs were not read (${firstLine(err)})`);
    }
  }
  return { outputs, gaps };
}
