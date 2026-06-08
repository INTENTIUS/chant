import type { LexiconPlugin } from "../lexicon";
import type { Serializer } from "../serializer";

/**
 * Parsed CLI arguments (output of parseArgs).
 */
export interface ParsedArgs {
  command: string;
  path: string;
  extraPositional?: string;
  extraPositional2?: string;
  output?: string;
  format: string;
  force?: boolean;
  fix: boolean;
  lexicon?: string;
  template?: string;
  watch: boolean;
  verbose: boolean;
  help: boolean;
  profile?: string;
  report?: boolean;
  /** `chant run` — force the local in-process executor (the default). */
  local?: boolean;
  /** `chant run` — run via a Temporal cluster instead of the local executor. */
  temporal?: boolean;
  /** `chant run` — emit the structured OpRunResult as JSON on stdout. */
  json?: boolean;
  live: boolean;
  /** `chant migrate --from <name>` (default "github") */
  migrateFrom?: string;
  /** `chant migrate --to <name>` (default "gitlab") */
  migrateTo?: string;
  /** `chant migrate --emit yaml|ts` */
  emit?: string;
  /** Escalate needs-review diagnostics to errors (migrate command) */
  strict?: boolean;
  /** Run glci/glab after emit (migrate command) */
  validate?: boolean;
  /** Recognise composite patterns in output (migrate command) */
  useComposites?: boolean;
  /** Write SARIF report to this path (migrate command); distinct from boolean --report */
  reportFile?: string;
  /** `chant init --skill <name>` filter (added in #95 commit) */
  skill?: string;
  /** `chant import --type <ResourceType>` selector */
  selectType?: string;
  /** `chant import --name <name>` selector */
  selectName?: string;
  /** `chant import --owned` — restrict live import to chant-owned resources */
  owned?: boolean;
  /** `chant import --verbatim` — keep server-defaulted fields in live import */
  verbatim?: boolean;
  /** `chant lifecycle … --src <dir>` — build root override for lifecycle commands */
  src?: string;
  /** `chant build --env <name>` — environment for organizational policy evaluation */
  env?: string;
  /** `chant graph --stacks` — render the cross-stack apply-ordering graph */
  stacks?: boolean;
  /** `chant lifecycle affected --base <ref>` — base git ref to diff against */
  base?: string;
  /** `chant lifecycle affected --head <ref>` — head git ref (default: working tree) */
  head?: string;
  /** `chant lifecycle affected --include-dependents` — add downstream consumers */
  includeDependents?: boolean;
}

/**
 * Declarative command definition for the CLI registry.
 */
export interface CommandDef {
  /** Primary command name, e.g. "build", "dev generate", "serve lsp" */
  name: string;
  /** If true, load lexicon plugins before calling handler */
  requiresPlugins?: boolean;
  /** Command handler — returns exit code */
  handler: (ctx: CommandContext) => Promise<number>;
}

/**
 * Context passed to each command handler.
 */
export interface CommandContext {
  args: ParsedArgs;
  plugins: LexiconPlugin[];
  serializers: Serializer[];
}

/**
 * Result of resolving a command from CLI args against the registry.
 */
export interface ResolvedCommand {
  def: CommandDef;
  /** True if this was matched as a compound command (args.path was consumed as subcommand) */
  compound: boolean;
}

/**
 * Resolve a command from parsed CLI args against the registry.
 *
 * Supports compound commands like "dev generate" where args.command="dev"
 * and args.path="generate". Falls back to simple command matching.
 */
/** Short command aliases. `chant lc …` is sugar for `chant lifecycle …`. */
const COMMAND_ALIASES: Record<string, string> = { lc: "lifecycle" };

export function resolveCommand(args: ParsedArgs, registry: CommandDef[]): ResolvedCommand | null {
  const command = COMMAND_ALIASES[args.command] ?? args.command;

  // Try compound command first: "dev generate", "serve lsp", "init lexicon"
  const compound = `${command} ${args.path}`;
  const compoundMatch = registry.find((c) => c.name === compound);
  if (compoundMatch) {
    return { def: compoundMatch, compound: true };
  }

  // Try simple command
  const simpleMatch = registry.find((c) => c.name === command);
  if (simpleMatch) {
    return { def: simpleMatch, compound: false };
  }

  return null;
}
