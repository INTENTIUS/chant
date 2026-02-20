#!/usr/bin/env bun

import { resolve } from "node:path";
import { formatSuccess, formatError } from "./format";
import { loadPlugins, resolveProjectLexicons } from "./plugins";
import { resolveCommand, type CommandDef, type ParsedArgs } from "./registry";
import { runBuild } from "./handlers/build";
import { runLint } from "./handlers/lint";
import { runDevGenerate, runDevPublish, runDevRollback, runDevUnknown } from "./handlers/dev";
import { runServeLsp, runServeMcp, runServeUnknown } from "./handlers/serve";
import { runInit, runInitLexicon } from "./handlers/init";
import { runList, runImport, runUpdate, runDoctor } from "./handlers/misc";

/**
 * Parse command line arguments
 */
export function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: "",
    path: ".",
    extraPositional: undefined,
    extraPositional2: undefined,
    output: undefined,
    format: "",
    force: undefined,
    fix: false,
    lexicon: undefined,
    watch: false,
    verbose: false,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--output" || arg === "-o") {
      result.output = args[++i];
    } else if (arg === "--format" || arg === "-f") {
      result.format = args[++i];
    } else if (arg === "--lexicon" || arg === "-d") {
      result.lexicon = args[++i];
    } else if (arg === "--force") {
      result.force = true;
    } else if (arg === "--fix") {
      result.fix = true;
    } else if (arg === "--watch" || arg === "-w") {
      result.watch = true;
    } else if (arg === "--verbose" || arg === "-v") {
      result.verbose = true;
    } else if (!arg.startsWith("-")) {
      if (!result.command) {
        result.command = arg;
      } else if (result.path === ".") {
        result.path = arg;
      } else if (!result.extraPositional) {
        result.extraPositional = arg;
      } else {
        result.extraPositional2 = arg;
      }
    }

    i++;
  }

  return result;
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
chant - Declarative infrastructure specification toolkit

Usage:
  chant <command> [options] [path]

Commands:
  init                  Initialize a new chant project
  init lexicon <name>   Scaffold a new lexicon plugin project
  build                 Build infrastructure from specification files
  lint                  Check specifications for issues
  list                  List discovered entities
  import                Import external template into TypeScript

Lexicon development:
  dev generate          Generate lexicon artifacts (+ validate + coverage)
  dev publish           Package lexicon for distribution
  dev rollback          List or restore generation snapshots

Servers:
  serve lsp             Start the LSP server (stdio)
  serve mcp             Start the MCP server (stdio)

Project:
  update                Sync lexicon types into .chant/types/
  doctor                Check project health and configuration

Options:
  -o, --output <file>   Write output to file instead of stdout
  -f, --format <fmt>    Output format (command-specific):
                        - build: json (default) or yaml
                        - list: text (default) or json
                        - lint: stylish (default), json, or sarif
  -d, --lexicon <name>  Build only the specified lexicon (e.g. aws, gitlab)
  --fix                 Auto-fix fixable issues (lint command)
  --force               Force overwrite existing files (import command)
  -w, --watch           Watch for changes and rebuild/re-lint (build, lint)
  -v, --verbose         Show stack traces on errors
  -h, --help            Show this help message

Examples:
  chant build ./infra/
  chant build ./infra/ --output stack.json
  chant build ./infra/ --format yaml
  chant build ./infra/ --watch
  chant import template.json --output ./infra/
  chant lint ./infra/
  chant lint ./infra/ --format sarif
  chant lint ./infra/ --watch
  chant list ./infra/
  chant list ./infra/ --format json
`);
}

/**
 * Load lexicon plugins for the given project path, or exit with an error.
 */
async function loadPluginsOrExit(path: string): Promise<import("../lexicon").LexiconPlugin[]> {
  let plugins;
  try {
    const lexiconNames = await resolveProjectLexicons(resolve(path));
    plugins = await loadPlugins(lexiconNames);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(formatError({ message: errorMessage }));
    process.exit(1);
  }

  if (plugins.length === 0) {
    console.error(formatError({
      message: "No lexicon detected",
      hint: 'Run "chant init --lexicon <name>" to initialize a project, or add a lexicon to chant.config.ts',
    }));
    process.exit(1);
  }

  return plugins;
}

// ── Command registry ──────────────────────────────────────────────

const registry: CommandDef[] = [
  // Primary commands
  { name: "build", requiresPlugins: true, handler: runBuild },
  { name: "lint", handler: runLint },
  { name: "list", handler: runList },
  { name: "import", handler: runImport },
  { name: "init", handler: runInit },
  { name: "init lexicon", handler: runInitLexicon },
{ name: "update", handler: runUpdate },
  { name: "doctor", handler: runDoctor },

  // Dev subcommands
  { name: "dev generate", requiresPlugins: true, handler: runDevGenerate },
  { name: "dev publish", requiresPlugins: true, handler: runDevPublish },
  { name: "dev rollback", requiresPlugins: true, handler: runDevRollback },

  // Serve subcommands
  { name: "serve lsp", requiresPlugins: true, handler: runServeLsp },
  { name: "serve mcp", requiresPlugins: true, handler: runServeMcp },

  // Fallback for unknown subcommands (must come after compound entries)
  { name: "dev", handler: runDevUnknown },
  { name: "serve", handler: runServeUnknown },
];

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.command) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const match = resolveCommand(args, registry);
  if (!match) {
    console.error(formatError({
      message: `Unknown command: ${args.command}`,
      hint: 'Run "chant --help" to see available commands',
    }));
    process.exit(1);
  }

  // For compound commands (e.g. "dev generate"), args.path is the subcommand,
  // so the project path shifts to extraPositional. For simple commands, use args.path.
  const projectPath = match.compound ? (args.extraPositional ?? ".") : args.path;
  const plugins = match.def.requiresPlugins
    ? await loadPluginsOrExit(projectPath)
    : [];
  const serializers = plugins.map((p) => p.serializer);
  const ctx = { args, plugins, serializers };

  process.exit(await match.def.handler(ctx));
}

// Only run main when executed directly, not when imported
if (import.meta.main) {
  main().catch((err) => {
    const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
    if (verbose && err instanceof Error && err.stack) {
      console.error(err.stack);
    } else {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    }
    process.exit(1);
  });
}
