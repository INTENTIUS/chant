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
  watch: boolean;
  verbose: boolean;
  help: boolean;
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
export function resolveCommand(args: ParsedArgs, registry: CommandDef[]): ResolvedCommand | null {
  // Try compound command first: "dev generate", "serve lsp", "init lexicon"
  const compound = `${args.command} ${args.path}`;
  const compoundMatch = registry.find((c) => c.name === compound);
  if (compoundMatch) {
    return { def: compoundMatch, compound: true };
  }

  // Try simple command
  const simpleMatch = registry.find((c) => c.name === args.command);
  if (simpleMatch) {
    return { def: simpleMatch, compound: false };
  }

  return null;
}
