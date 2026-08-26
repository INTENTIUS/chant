import type { LexiconPlugin } from "../lexicon";

/**
 * The lexicon command-group seam (chant #1078).
 *
 * A lexicon may contribute one CLI verb group, mounted under `chant <name>
 * <verb>` (e.g. `chant kube get`). Core's only job is to find the group and
 * call the matched verb's handler — it never inspects, validates, or
 * special-cases what a verb does. That is the whole point: `get -o wide -l
 * app=x --field-selector` is Kubernetes vocabulary, not something core could
 * generalize even if it tried (see #1078's motivating case, consumed by
 * #1079's `chant kube`).
 *
 * This is a DIFFERENT shape from `LexiconPlugin.emulator` (#920): the
 * emulator capability is DATA that core itself aggregates across every
 * configured lexicon (`chant emulator up --all` loops every plugin with an
 * `emulator`). A command group is BEHAVIOR owned end-to-end by one lexicon —
 * core dispatches to it wholesale and never loops or merges across plugins.
 * The two capabilities are not layers of the same thing; migrating
 * `emulator` onto this seam would be a worse fit, not a simplification.
 */

/** Context handed to a mounted command's handler. */
export interface CommandGroupContext {
  /** The verb invoked, e.g. `"get"` for `chant kube get pods`. */
  verb: string;
  /**
   * Every CLI token after the group name and verb, unparsed — e.g. `chant
   * kube get pods -o wide` hands `["pods", "-o", "wide"]`. Core does not
   * interpret these: it has no vocabulary for a lexicon's own verbs. A
   * handler that wants #1127's joined-`--flag=value` splitting and
   * unknown-flag rejection can reuse {@link splitJoinedFlags} /
   * {@link unknownFlagError} from this module for the same discipline core's
   * own parser applies, scoped to whatever flags this verb actually accepts.
   */
  rawArgs: string[];
}

/** One verb within a lexicon-contributed command group. */
export interface CommandGroupCommand {
  /** Verb name, e.g. `"get"`, `"logs"`, `"version"`. */
  name: string;
  /** One-line description shown in `chant --help` and in usage errors. */
  description: string;
  /** Runs the verb. Returns the process exit code. */
  handler: (ctx: CommandGroupContext) => Promise<number>;
}

/**
 * A CLI verb group contributed by a lexicon (chant #1078). Mounted under
 * `chant <name> <verb>`. Returned from {@link LexiconPlugin.commands}.
 */
export interface CommandGroup {
  /** Namespace this group mounts under, e.g. `"kube"` for `chant kube <verb>`. */
  name: string;
  /** One-line description shown in `chant --help`'s composed listing. */
  description: string;
  /** Verbs in this group. */
  commands: CommandGroupCommand[];
}

/**
 * Top-level command words core's own static registry already owns
 * (`packages/core/src/cli/main.ts`'s `registry`). A lexicon's `commands()`
 * group name colliding with one of these is always unreachable — core's own
 * registry is resolved first, unconditionally — so `checkConflicts`
 * (./conflict-check.ts) treats a collision as a hard, loud failure at
 * plugin-load time rather than a silently-ignored command group. Hand
 * maintained alongside the registry; update both together.
 */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "build", "lint", "list", "describe", "import", "audit", "migrate", "carve",
  "init", "update", "doctor", "dev", "run", "graph", "vendor", "lifecycle",
  "lc", "components", "emulator", "serve", "operator", "approve",
]);

/**
 * chant #1127 — split a joined `--flag=value` token into two array elements
 * (`--flag`, `value`), the same discipline core's own `parseArgs` applies,
 * generalized so a lexicon's mounted command can reuse it for its own flag
 * vocabulary instead of reimplementing the split. Throws the same shape of
 * error as core's parser when `flag` is declared boolean but was given a
 * value — a boolean has nothing to assign, and silently reinterpreting the
 * joined value as the next positional would be exactly the silent misparse
 * #1127 closed for core's own flags.
 */
export function splitJoinedFlags(args: string[], booleanFlags: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      const flag = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (booleanFlags.has(flag)) {
        throw new Error(`${arg} — ${flag} is a boolean flag and does not take a value. Pass ${flag} on its own.`);
      }
      out.push(flag, value);
    } else {
      out.push(arg);
    }
  }
  return out;
}

/**
 * Same "Unknown flag" error shape core's own `parseArgs` throws (#1127), for
 * a mounted command's own flag vocabulary — core doesn't know that
 * vocabulary, so it can't produce this error itself; the handler does, using
 * this helper for a consistent message.
 */
export function unknownFlagError(flag: string, hint = `Run "chant --help" to see supported flags.`): Error {
  return new Error(`Unknown flag: ${flag}\n${hint}`);
}

/** Result of looking up a command group + verb among loaded plugins. */
export type CommandGroupLookup =
  | { kind: "no-group" }
  | { kind: "no-verb"; group: CommandGroup }
  | { kind: "unknown-verb"; group: CommandGroup }
  | { kind: "matched"; plugin: LexiconPlugin; group: CommandGroup; command: CommandGroupCommand };

/**
 * Find the plugin (if any) whose `commands()` group is named `groupName`,
 * and the verb within it named `verbName`. Pure — does no I/O, calls
 * `plugin.commands()` at most once per plugin (registration, not execution:
 * this never invokes a verb's handler).
 */
export function resolveCommandGroupVerb(
  plugins: readonly LexiconPlugin[],
  groupName: string,
  verbName: string | undefined,
): CommandGroupLookup {
  for (const plugin of plugins) {
    const group = plugin.commands?.();
    if (!group || group.name !== groupName) continue;
    if (verbName === undefined) return { kind: "no-verb", group };
    const command = group.commands.find((c) => c.name === verbName);
    if (!command) return { kind: "unknown-verb", group };
    return { kind: "matched", plugin, group, command };
  }
  return { kind: "no-group" };
}

/** Every command group contributed by the given loaded plugins, in plugin order. */
export function collectCommandGroups(plugins: readonly LexiconPlugin[]): CommandGroup[] {
  const groups: CommandGroup[] = [];
  for (const plugin of plugins) {
    const group = plugin.commands?.();
    if (group) groups.push(group);
  }
  return groups;
}

/** Result of {@link dispatchCommandGroup}. */
export type CommandGroupDispatch =
  | { kind: "no-group" }
  | { kind: "usage-error"; message: string; hint: string }
  | { kind: "ran"; exitCode: number };

/**
 * Resolve `groupName`/`verbName` against the loaded plugins and, if matched,
 * run the verb's handler with `rawArgs`. Returns `{ kind: "no-group" }` when
 * nothing claims `groupName` at all — the caller's cue to fall back to its
 * own "unknown command" handling — and a printable usage error when the
 * group matched but the verb didn't (or was omitted).
 */
export async function dispatchCommandGroup(
  plugins: readonly LexiconPlugin[],
  groupName: string,
  verbName: string | undefined,
  rawArgs: string[],
): Promise<CommandGroupDispatch> {
  const lookup = resolveCommandGroupVerb(plugins, groupName, verbName);
  if (lookup.kind === "no-group") return { kind: "no-group" };
  if (lookup.kind === "matched") {
    const exitCode = await lookup.command.handler({ verb: verbName as string, rawArgs });
    return { kind: "ran", exitCode };
  }
  const verbs = lookup.group.commands.map((c) => `  ${c.name.padEnd(14)} ${c.description}`).join("\n");
  const message =
    lookup.kind === "unknown-verb"
      ? `Unknown ${groupName} subcommand: ${verbName}`
      : `Usage: chant ${groupName} <verb> [args...]`;
  return { kind: "usage-error", message, hint: `Available verbs:\n${verbs}` };
}

/**
 * Render the `--help` section listing every lexicon-contributed command
 * group. Empty string when there are none, so a caller can splice it in
 * unconditionally without an extra length check.
 */
export function formatCommandGroupsHelp(groups: readonly CommandGroup[]): string {
  if (groups.length === 0) return "";
  const lines = groups.flatMap((g) => [
    `  ${g.name.padEnd(20)}  ${g.description}`,
    ...g.commands.map((c) => `    ${g.name} ${c.name.padEnd(Math.max(1, 17 - g.name.length))}${c.description}`),
  ]);
  return `Lexicon commands:\n${lines.join("\n")}\n`;
}
