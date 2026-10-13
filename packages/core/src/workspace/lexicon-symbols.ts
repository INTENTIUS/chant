/**
 * Symbol resolvers a member's lexicons contribute (#3313), for
 * `chant workspace graph --intent <path>#<symbol>` on a file core's own
 * resolver does not read (`symbols.ts`).
 *
 * The lexicons are the ones the member's `chant.config.ts` (or `.json`)
 * names, read without running the config when it can be read statically
 * (`../config-static.ts`), and by loading it as `chant run` does otherwise.
 * Each is loaded as any command loads it (`loadPlugin`), and its plugin's
 * `symbolResolvers()` answers. A lexicon that can't be loaded, or whose
 * resolvers are malformed, contributes nothing, and the reason is kept so a
 * refusal can say why the file has no resolver.
 */

import { join } from "node:path";
import { lexiconNames } from "../lexicon-module";
import type { SymbolDeclaration, SymbolResolver } from "./symbols";

/** Loads a lexicon plugin by name; `loadPlugin` from the CLI unless a test swaps it. */
export type SymbolPluginLoader = (name: string) => Promise<{ name?: string; symbolResolvers?: () => unknown }>;

export interface MemberSymbolResolvers {
  resolvers: SymbolResolver[];
  /** Why a lexicon contributed nothing it may have meant to: its config or plugin couldn't be read, or a resolver was malformed. */
  problems: string[];
}

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0];

/** A resolver a plugin returned, checked: a language, extensions starting with a dot, and a declarations function. */
function checked(lexicon: string, value: unknown, problems: string[]): SymbolResolver | undefined {
  const r = value as Partial<SymbolResolver> | null;
  const ok =
    r !== null &&
    typeof r === "object" &&
    typeof r.language === "string" &&
    Array.isArray(r.extensions) &&
    r.extensions.length > 0 &&
    r.extensions.every((e) => typeof e === "string" && /^\.[^./\\]+$/.test(e)) &&
    typeof r.declarations === "function";
  if (!ok) {
    problems.push(`lexicon "${lexicon}" returned a symbol resolver that is not { language, extensions: [".ext", ...], declarations(path, text) }`);
    return undefined;
  }
  const declarations = r.declarations!.bind(r);
  return {
    language: `${r.language} (lexicon ${lexicon})`,
    extensions: [...r.extensions!],
    // A resolver's output is checked where it is used, so a bad entry is dropped rather than read as lines.
    declarations(path: string, text: string): SymbolDeclaration[] {
      const out = declarations(path, text);
      if (!Array.isArray(out)) return [];
      return out.filter(
        (d) =>
          d !== null &&
          typeof d === "object" &&
          typeof d.qualified === "string" &&
          d.qualified !== "" &&
          typeof d.kind === "string" &&
          Number.isInteger(d.lines?.start) &&
          Number.isInteger(d.lines?.end) &&
          d.lines.start >= 1 &&
          d.lines.end >= d.lines.start,
      );
    },
  };
}

/** The lexicon names a member's config declares: read statically when it can be, else by loading the config. */
async function memberLexicons(dir: string): Promise<string[]> {
  const { readLexiconDeclarationsStatically } = await import("../config-static");
  const read = readLexiconDeclarationsStatically(dir);
  if (read.status === "no-config") return [];
  if (read.status === "read") {
    const { registerLexiconDeclarations } = await import("../lexicon-module");
    const { dirname } = await import("node:path");
    registerLexiconDeclarations(read.entries, dirname(read.configPath));
    return lexiconNames(read.entries);
  }
  const { loadChantConfig } = await import("../config");
  const { config } = await loadChantConfig(dir);
  return lexiconNames(config.lexicons ?? []);
}

/** The symbol resolvers the lexicons of the member at `dir` (on disk) contribute, in config order. */
export async function memberSymbolResolvers(dir: string, load?: SymbolPluginLoader): Promise<MemberSymbolResolvers> {
  const problems: string[] = [];
  let names: string[];
  try {
    names = await memberLexicons(dir);
  } catch (err) {
    return { resolvers: [], problems: [`its chant.config could not be read: ${firstLine(err)}`] };
  }
  const loader = load ?? ((await import("../cli/plugins")).loadPlugin as SymbolPluginLoader);
  const resolvers: SymbolResolver[] = [];
  for (const name of names) {
    let plugin: Awaited<ReturnType<SymbolPluginLoader>>;
    try {
      plugin = await loader(name);
    } catch (err) {
      problems.push(`lexicon "${name}" could not be loaded: ${firstLine(err)}`);
      continue;
    }
    if (typeof plugin.symbolResolvers !== "function") continue;
    let listed: unknown;
    try {
      listed = plugin.symbolResolvers();
    } catch (err) {
      problems.push(`lexicon "${name}" symbolResolvers() threw: ${firstLine(err)}`);
      continue;
    }
    if (!Array.isArray(listed)) {
      problems.push(`lexicon "${name}" symbolResolvers() did not return a list`);
      continue;
    }
    for (const r of listed) {
      const ok = checked(name, r, problems);
      if (ok) resolvers.push(ok);
    }
  }
  return { resolvers, problems };
}

/** The member directory on disk for a member's `dir` under the workspace root. */
export const memberDirOnDisk = (root: string, dir: string): string => (dir === "." ? root : join(root, ...dir.split("/")));
