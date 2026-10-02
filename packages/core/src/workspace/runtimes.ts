/**
 * The runtimes a member's components can deploy on, for `chant workspace
 * graph --composites` (#2674): the built-in `local` runtime, and every lexicon
 * the member's `chant.config.ts` configures whose `opRuntime` hosts
 * `chant run --components`. That is the list `chant run --components <name>
 * --on <runtime>` accepts in the member's directory (`../cli/handlers/run.ts`),
 * so a reader such as hud offers these and never guesses a runtime.
 *
 * `local` is the default. A configured default (`run.on`) is read once the
 * config type has one; until then the command without `--on` runs locally.
 *
 * The config is read the way `chant run` reads it, from the member's
 * directory, in the working tree or in the tree `--at` exported. Reading it
 * runs the member's `chant.config.ts` and imports the lexicons it lists.
 */

import { join } from "node:path";
import type { EnvironmentDeclaration } from "../config";
import { lexiconNames } from "../lexicon-module";
import type { ReasonCode } from "./reason-codes";

/** The runtime core provides, which `chant run` uses without `--on`. */
export const LOCAL_RUNTIME = "local";

/** Why a member's runtimes list only part of what its config names. Closed: part of the read contract. */
export const RUNTIME_REASON_CODES = [
  /** The member's chant.config.ts could not be read, so only local is listed. */
  "runtimes-config-unreadable",
  /** A configured lexicon could not be loaded, so it is not listed. */
  "runtimes-lexicon-unreadable",
] as const satisfies readonly ReasonCode[];
export type RuntimeReasonCode = (typeof RUNTIME_REASON_CODES)[number];

export interface RuntimeReason {
  code: RuntimeReasonCode;
  message: string;
}

/** One runtime a component can deploy on. */
export interface ComponentRuntime {
  /** What `--on` takes: the lexicon's name, or `local`. */
  name: string;
  /** The lexicon that hosts it, or null for `local`. */
  lexicon: string | null;
  /** True for the runtime `chant run --components` uses without `--on`. */
  default: boolean;
  /** The command that deploys the component on it, run in the member's directory. */
  command: string;
}

/** What one member's config says about runtimes. */
export interface MemberRuntimes {
  /** Configured lexicons whose `opRuntime` hosts component runs, in config order. */
  lexicons: string[];
  /** The default runtime's name. */
  default: string;
  reasons: RuntimeReason[];
  /**
   * The config's `environments`, read in the same load (#2695): `[]` when it
   * declares none, null when the config couldn't be read.
   */
  environments: EnvironmentDeclaration[] | null;
}

/** Loads a lexicon plugin by name; `loadPlugin` from the CLI unless a test swaps it. */
export type PluginLoader = (name: string) => Promise<{ opRuntime?: { runComponents?: unknown } }>;

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0];

/** Read the runtimes a member's config offers. `dir` is the member's directory on disk. */
export async function readMemberRuntimes(dir: string, load?: PluginLoader): Promise<MemberRuntimes> {
  const reasons: RuntimeReason[] = [];
  let names: string[];
  let environments: EnvironmentDeclaration[];
  try {
    const { loadChantConfig } = await import("../config");
    const { config } = await loadChantConfig(dir);
    names = lexiconNames(config.lexicons ?? []);
    environments = config.environments ?? [];
  } catch (err) {
    return { lexicons: [], default: LOCAL_RUNTIME, reasons: [{ code: "runtimes-config-unreadable", message: `chant.config.ts: ${firstLine(err)}` }], environments: null };
  }
  const loader = load ?? (await import("../cli/plugins")).loadPlugin;
  const lexicons: string[] = [];
  for (const name of names) {
    try {
      const plugin = await loader(name);
      if (plugin.opRuntime?.runComponents) lexicons.push(name);
    } catch (err) {
      reasons.push({ code: "runtimes-lexicon-unreadable", message: `lexicon "${name}": ${firstLine(err)}` });
    }
  }
  return { lexicons, default: LOCAL_RUNTIME, reasons, environments };
}

/** The runtimes one component can deploy on, `local` first, each with its command line. */
export function componentRuntimes(component: string, member: MemberRuntimes | undefined): ComponentRuntime[] {
  const def = member?.default ?? LOCAL_RUNTIME;
  const entry = (name: string, lexicon: string | null): ComponentRuntime => ({
    name,
    lexicon,
    default: name === def,
    command: `chant run --components ${component}${name === LOCAL_RUNTIME ? "" : ` --on ${name}`}`,
  });
  return [entry(LOCAL_RUNTIME, null), ...(member?.lexicons ?? []).filter((l) => l !== LOCAL_RUNTIME).map((l) => entry(l, l))];
}

/** Read the runtimes of each member of kind chant, from the tree at `root`. */
export async function readRuntimesIn(root: string, members: readonly { name: string; dir: string; kind: string }[], load?: PluginLoader): Promise<Map<string, MemberRuntimes>> {
  const out = new Map<string, MemberRuntimes>();
  for (const m of members) {
    if (m.kind !== "chant") continue;
    out.set(m.name, await readMemberRuntimes(m.dir === "." ? root : join(root, ...m.dir.split("/")), load));
  }
  return out;
}
