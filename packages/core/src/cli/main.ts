#!/usr/bin/env tsx

import { resolve } from "node:path";
import { formatSuccess, formatError } from "./format";
import { loadPlugins, resolveProjectLexicons } from "./plugins";
import { resolveCommand, type CommandDef, type ParsedArgs } from "./registry";
import { loadChantConfig } from "../config";
import { initRuntime } from "../runtime-adapter";
import { runBuild } from "./handlers/build";
import { runLint } from "./handlers/lint";
import { runDevGenerate, runDevPublish, runDevOnboard, runDevCheckLexicon, runDevUnknown } from "./handlers/dev";
import { runServeLsp, runServeMcp, runServeUnknown } from "./handlers/serve";
import { runInit, runInitLexicon } from "./handlers/init";
import { runList, runDescribe, runImport, runAudit, runUpdate, runDoctor } from "./handlers/misc";
import { runVendor } from "./handlers/vendor";
import { runMigrate } from "./handlers/migrate";
import { runLifecycleSnapshot, runLifecycleShow, runLifecycleDiff, runLifecyclePlan, runLifecycleAffected, runLifecycleLog, runLifecycleUnknown } from "./handlers/lifecycle";
import { runGraph } from "./handlers/graph";
import { runOp, runOpList, runOpStatus, runOpSignal, runOpCancel, runOpLog } from "./handlers/run";

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
    template: undefined,
    watch: false,
    verbose: false,
    help: false,
    profile: undefined,
    report: undefined,
    local: undefined,
    temporal: undefined,
    json: undefined,
    live: false,
    migrateFrom: undefined,
    migrateTo: undefined,
    emit: undefined,
    strict: false,
    validate: false,
    useComposites: false,
    reportFile: undefined,
    skill: undefined,
    src: undefined,
    env: undefined,
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
    } else if (arg === "--template" || arg === "-t") {
      result.template = args[++i];
    } else if (arg === "--force") {
      result.force = true;
    } else if (arg === "--fix") {
      result.fix = true;
    } else if (arg === "--watch" || arg === "-w") {
      result.watch = true;
    } else if (arg === "--verbose" || arg === "-v") {
      result.verbose = true;
    } else if (arg === "--profile" || arg === "-p") {
      result.profile = args[++i];
    } else if (arg === "--report") {
      // --report alone is the boolean (used by `run`); --report <path> is
      // the migrate-command file path. Look ahead for a non-flag.
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        result.reportFile = next;
        i++;
      } else {
        result.report = true;
      }
    } else if (arg === "--live") {
      result.live = true;
    } else if (arg === "--from") {
      // Shared by `migrate --from <lexicon>` and `import --from <env>`; the
      // two commands never run together, so one field carries both.
      result.migrateFrom = args[++i];
    } else if (arg === "--type") {
      result.selectType = args[++i];
    } else if (arg === "--name") {
      result.selectName = args[++i];
    } else if (arg === "--owned") {
      result.owned = true;
    } else if (arg === "--verbatim") {
      result.verbatim = true;
    } else if (arg === "--to") {
      result.migrateTo = args[++i];
    } else if (arg === "--emit") {
      result.emit = args[++i];
    } else if (arg === "--strict") {
      result.strict = true;
    } else if (arg === "--validate") {
      result.validate = true;
    } else if (arg === "--use-composites") {
      result.useComposites = true;
    } else if (arg === "--skill") {
      result.skill = args[++i];
    } else if (arg === "--src") {
      result.src = args[++i];
    } else if (arg === "--env") {
      result.env = args[++i];
    } else if (arg === "--tier") {
      result.tier = args[++i];
    } else if (arg === "--fail-on") {
      result.failOn = args[++i];
    } else if (arg === "--theme") {
      result.theme = args[++i];
    } else if (arg === "--stacks") {
      result.stacks = true;
    } else if (arg === "--base") {
      result.base = args[++i];
    } else if (arg === "--head") {
      result.head = args[++i];
    } else if (arg === "--include-dependents") {
      result.includeDependents = true;
    } else if (arg === "--local") {
      result.local = true;
    } else if (arg === "--temporal") {
      result.temporal = true;
    } else if (arg === "--json") {
      result.json = true;
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
  describe              Show the effective config for one component
  vendor                Pull pinned, checksummed patterns into your repo
  import                Import external template into TypeScript
  audit [path|url]      Audit a repo's CI YAML for security issues
                        (--format stylish|json|sarif|markdown|html, -o <file>,
                         --tier merge-worthy|all, --fail-on merge-worthy|warning|none,
                         --template <file> / --theme <file> for the html report)
  migrate <file>        Translate a workflow between lexicons
                        (default: --from github --to gitlab)

Ops:
  run <name>            Start an Op workflow (spawns worker + submits to Temporal)
  run list              List all Ops with current run status
  run status <name>     Show current workflow run state
  run signal <name> <signal>  Send a named signal to unblock a gate
  run cancel <name>     Cancel the active workflow run (requires --force)
  run log <name>        Show run history for an Op

  graph                 Show Op dependency graph (--stacks for cross-stack order,
                        --format ir for the lint-gated entity-graph IR)

Lifecycle (alias: lc):
  lifecycle snapshot <env>  Query API, save metadata to orphan branch
  lifecycle show <env>      Show latest lifecycle snapshot
  lifecycle diff <env>      Compare current build against last snapshot
                            --live: query cloud now and detect drift
  lifecycle plan <env>      Typed change set (create/update/delete/adopt) vs live
  lifecycle affected        Stacks a change affects (--base <ref> [--include-dependents])
                            --json: emit the ChangeSet as JSON
  lifecycle log [env]       History of lifecycle snapshots

Lexicon development:
  dev generate          Generate lexicon artifacts (+ validate + coverage)
  dev publish           Package lexicon for distribution
  dev onboard <name>    Patch CI, Dockerfiles, and workflows for a new lexicon
  dev check-lexicon <dir>  Check lexicon completeness (tier 1/2/3)

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
      --env <name>      Environment for organizational policy evaluation (build)
  -t, --template <name> Init template (e.g. node-pipeline, docker-build)
  --skill <name>        Init: install only this skill from the lexicon
  --fix                 Auto-fix fixable issues (lint command)
  --force               Force overwrite existing files (import command)
  -w, --watch           Watch for changes and rebuild/re-lint (build, lint)
  -v, --verbose         Show stack traces on errors
  -h, --help            Show this help message
  -p, --profile <name>  Temporal worker profile to use (run command)
  --local               Run an Op with the local in-process executor (default)
  --temporal            Run an Op via a Temporal cluster (gates, schedules, durable resume)
  --json                Emit the structured run result as JSON (run command)
  --report              Print deployment report instead of running (run command)
                        OR with a path arg: SARIF report destination (migrate)
                        OR '--report gitlab-mr': emit the GitLab MR plan-widget
                        JSON (lifecycle plan)
  --from <name>         Source lexicon for migrate (default: github)
  --to <name>           Target lexicon for migrate (default: gitlab)
  --emit <fmt>          Migration output format: yaml (default) or ts
  --strict              Escalate needs-review/validation to errors (migrate)
  --validate            Run external validator (glci/glab) after migrate
  --use-composites      Rewrite to composite calls when patterns match (migrate)

Examples:
  chant build ./infra/
  chant build ./infra/ --output stack.json
  chant build ./infra/ --format yaml
  chant build ./infra/ --watch
  chant import template.json --output ./infra/
  chant import --from prod --name my-bucket --output src/
  chant lint ./infra/
  chant lint ./infra/ --format sarif
  chant lint ./infra/ --watch
  chant list ./infra/
  chant list ./infra/ --format json
  chant describe myComponent src/
  chant describe myComponent src/ --format json
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
  { name: "describe", handler: runDescribe },
  { name: "import", handler: runImport },
  { name: "audit", handler: runAudit },
  { name: "migrate", handler: runMigrate },
  { name: "init", handler: runInit },
  { name: "init lexicon", handler: runInitLexicon },
{ name: "update", handler: runUpdate },
  { name: "doctor", handler: runDoctor },

  // Dev subcommands
  { name: "dev generate", requiresPlugins: true, handler: runDevGenerate },
  { name: "dev publish", requiresPlugins: true, handler: runDevPublish },
  { name: "dev onboard", handler: runDevOnboard },
  { name: "dev check-lexicon", handler: runDevCheckLexicon },

  // Op / run subcommands
  { name: "run list", handler: runOpList },
  { name: "run status", handler: runOpStatus },
  { name: "run signal", handler: runOpSignal },
  { name: "run cancel", handler: runOpCancel },
  { name: "run log", handler: runOpLog },
  { name: "run", handler: runOp },

  { name: "graph", handler: runGraph },
  { name: "vendor", handler: runVendor },

  // State subcommands
  { name: "lifecycle snapshot", requiresPlugins: true, handler: runLifecycleSnapshot },
  { name: "lifecycle show", handler: runLifecycleShow },
  { name: "lifecycle diff", requiresPlugins: true, handler: runLifecycleDiff },
  { name: "lifecycle plan", requiresPlugins: true, handler: runLifecyclePlan },
  { name: "lifecycle affected", requiresPlugins: true, handler: runLifecycleAffected },
  { name: "lifecycle log", handler: runLifecycleLog },

  // Serve subcommands
  { name: "serve lsp", requiresPlugins: true, handler: runServeLsp },
  { name: "serve mcp", requiresPlugins: true, handler: runServeMcp },

  // Fallback for unknown subcommands (must come after compound entries)
  { name: "lifecycle", handler: runLifecycleUnknown },
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

  // Initialize runtime adapter early — before plugins or commands run
  const projectPath0 = resolve(args.path === "." ? "." : args.path);
  try {
    await loadChantConfig(projectPath0);
    initRuntime();
  } catch {
    // Config may not exist yet (e.g. `chant init`)
    initRuntime();
  }

  const match = resolveCommand(args, registry);
  if (!match) {
    console.error(formatError({
      message: `Unknown command: ${args.command}`,
      hint: 'Run "chant --help" to see available commands',
    }));
    process.exit(1);
  }

  // For compound commands (e.g. "run list", "lifecycle plan <env>"), the first
  // positional is a subcommand argument — an environment, op, or lexicon name —
  // not a project path. Plugins always load from the cwd; the handler reads its
  // own positionals from args.extraPositional. Using extraPositional as the path
  // here pointed plugin resolution at e.g. "./local" for `lifecycle plan local`,
  // which then fell through to import-detection on an empty file set and failed
  // with "No lexicon detected" even though chant.config.ts lists the lexicons.
  const projectPath = match.compound ? "." : args.path;
  const plugins = match.def.requiresPlugins
    ? await loadPluginsOrExit(projectPath)
    : [];
  const serializers = plugins.map((p) => p.serializer);
  const ctx = { args, plugins, serializers };

  process.exit(await match.def.handler(ctx));
}

// Only run main when executed directly, not when imported
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
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
