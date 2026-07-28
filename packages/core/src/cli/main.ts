#!/usr/bin/env tsx

import { resolve } from "node:path";
import { isEntryPoint } from "./is-entry-point";
import { formatSuccess, formatError } from "./format";
import { loadPlugins, resolveProjectLexicons } from "./plugins";
import { resolveCommand, type CommandDef, type ParsedArgs } from "./registry";
import { loadChantConfigUpward } from "../config";
import { armSandboxConfigEvaluation } from "../config-sandbox";
import { armSandboxPolicyExecution } from "../lint/policy-import";
import { ENV_VAR, unknownEnvError } from "../env";
import { initRuntime } from "../runtime-adapter";
import { runBuild } from "./handlers/build";
import { runLint } from "./handlers/lint";
import { runDevGenerate, runDevPublish, runDevOnboard, runDevCheckLexicon, runDevSurfaceDiff, runDevPinnedUpgrade, runDevRollingUpgrade, runDevUnknown } from "./handlers/dev";
import { runServeLsp, runServeMcp, runServeUnknown } from "./handlers/serve";
import { runInit, runInitLexicon } from "./handlers/init";
import { runList, runDescribe, runImport, runAudit, runUpdate, runDoctor } from "./handlers/misc";
import { runVendor } from "./handlers/vendor";
import { runMigrate } from "./handlers/migrate";
import { runCarveAdvise, runCarveUnknown } from "./handlers/carve";
import { runCarveEmit } from "./handlers/carve-emit";
import { runCarveBridge } from "./handlers/carve-bridge";
import { runCarveApply } from "./handlers/carve-apply";
import { runLifecycleSnapshot, runLifecycleShow, runLifecycleDiff, runLifecycleRollback, runLifecyclePlan, runLifecycleAffected, runLifecycleLog, runLifecycleUnknown } from "./handlers/lifecycle";
import { runComponentsStatus, runComponentsReleaseRecord, runComponentsUnknown } from "./handlers/components";
import { runGraph } from "./handlers/graph";
import { runOp, runOpList, runOpStatus, runOpSignal, runOpCancel, runOpLog } from "./handlers/run";
import { runEmulator } from "./handlers/emulator";

/**
 * Long-form flags that are pure booleans in {@link parseArgs} — their branch
 * below sets a field to `true` and never consumes a following array element.
 * Used only to reject a joined `--flag=value` form for these (chant #1127):
 * a boolean has no value to assign, and silently reinterpreting the joined
 * value as the next positional argument (path, component name, ...) would be
 * exactly the kind of silent misparse this issue exists to close. `--report`
 * is deliberately excluded — it's context-sensitive (bare boolean vs a SARIF
 * path, decided by lookahead), so a joined value for it is legitimate and
 * already handled correctly once split.
 */
const BOOLEAN_FLAGS = new Set([
  "--help",
  "--force",
  "--fix",
  "--watch",
  "--verbose",
  "--live",
  "--overlay",
  "--owned",
  "--verbatim",
  "--apply-rewrites",
  "--write",
  "--strict",
  "--validate",
  "--use-composites",
  "--stacks",
  "--components",
  "--up",
  "--down",
  "--include-dependents",
  "--local",
  "--temporal",
  "--json",
  "--progress-json",
  "--update-snapshot",
  "--update-baseline",
  "--run-examples",
  "--check",
  "--bump",
  "--no-release-record",
  "--fold",
  "--no-fold",
  "--sandbox",
]);

/**
 * Parse command line arguments
 */
export function parseArgs(args: string[]): ParsedArgs {
  // Local mutable copy — chant #1127's joined-`--flag=value` splitting below
  // rewrites the array in place (one token becomes two), so this must not
  // mutate whatever array the caller passed in (e.g. `process.argv.slice(2)`
  // is already a fresh copy, but callers shouldn't have to know that).
  args = args.slice();

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
    param: undefined,
    paramsFile: undefined,
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
    let arg = args[i];

    // chant #1127 — generic joined `--flag=value` support. Every value-taking
    // flag below is matched by an exact `arg === "--flag"` check and then
    // consumes the *next* array element (`args[++i]`) as its value; a joined
    // token like `--env=prod` never matches any of those, doesn't match the
    // trailing positional branch either (it starts with `-`), and used to
    // vanish with no error. Splitting the token at its FIRST `=` and
    // re-dispatching as two array elements makes every flag below see the
    // exact shape it already handles — including a flag like `--param`
    // whose own value legitimately contains `=` (`--param=tier=production`
    // splits to flag `--param`, value `tier=production`, not further split
    // on the second `=`).
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      const flag = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (BOOLEAN_FLAGS.has(flag)) {
        throw new Error(`${arg} — ${flag} is a boolean flag and does not take a value. Pass ${flag} on its own.`);
      }
      args.splice(i, 1, flag, value);
      arg = args[i];
    }

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
    } else if (arg === "--overlay") {
      result.overlay = true;
    } else if (arg === "--between") {
      result.betweenA = args[++i];
      result.betweenB = args[++i];
      if (!result.betweenA || !result.betweenB) throw new Error("--between needs two snapshot refs: --between <refA> <refB>");
    } else if (arg === "--overlay-anchor") {
      const v = args[++i];
      if (v !== "source" && v !== "live") throw new Error(`--overlay-anchor must be 'source' or 'live', got '${v}'`);
      result.overlayAnchor = v;
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
    } else if (arg === "--state") {
      result.statePath = args[++i];
    } else if (arg === "--select") {
      result.selectAddress = args[++i];
    } else if (arg === "--live-name") {
      result.liveName = args[++i];
    } else if (arg === "--apply-rewrites") {
      result.applyRewrites = true;
    } else if (arg === "--stack") {
      result.carveStack = args[++i];
    } else if (arg === "--write") {
      result.write = true;
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
    } else if (arg === "--components") {
      result.components = true;
    } else if (arg === "--generate") {
      result.generate = args[++i];
    } else if (arg === "--dump-outputs") {
      result.dumpOutputs = args[++i];
    } else if (arg === "--seed-outputs") {
      (result.seedOutputs ??= []).push(args[++i]);
    } else if (arg === "--detail") {
      result.detail = Number(args[++i]);
    } else if (arg === "--lens") {
      result.lens = args[++i];
    } else if (arg === "--up") {
      result.up = true;
    } else if (arg === "--down") {
      result.down = true;
    } else if (arg === "--node-sizes") {
      result.nodeSizes = args[++i];
    } else if (arg === "--layout-engine") {
      result.layoutEngine = args[++i];
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
    } else if (arg === "--progress-json") {
      result.progressJson = true;
    } else if (arg === "--update-snapshot") {
      result.updateSnapshot = true;
    } else if (arg === "--update-baseline") {
      result.updateBaseline = true;
    } else if (arg === "--run-examples") {
      result.runExamples = true;
    } else if (arg === "--pinned-digest") {
      result.pinnedDigest = args[++i];
    } else if (arg === "--check") {
      result.check = true;
    } else if (arg === "--bump") {
      result.bump = true;
    } else if (arg === "--component") {
      result.component = args[++i];
    } else if (arg === "--digest") {
      result.digest = args[++i];
    } else if (arg === "--git-sha") {
      result.gitSha = args[++i];
    } else if (arg === "--run-id") {
      result.runId = args[++i];
    } else if (arg === "--actor") {
      result.actor = args[++i];
    } else if (arg === "--approver") {
      result.approver = args[++i];
    } else if (arg === "--compare-to") {
      result.compareTo = args[++i];
    } else if (arg === "--no-release-record") {
      result.noReleaseRecord = true;
    } else if (arg === "--fold") {
      result.fold = true;
    } else if (arg === "--no-fold") {
      // chant #1134 — fold is the default build path; this is the explicit
      // opt-out, and like --fold it beats chant.config.ts's build.fold.
      result.fold = false;
    } else if (arg === "--sandbox") {
      result.sandbox = true;
    } else if (arg === "--param") {
      // chant #1118/#1127 — `--param name=value` (space-separated) and
      // `--param=name=value` (joined, split above at its first `=` into flag
      // `--param` + value `name=value`) both land here and behave
      // identically; there is no separate joined-form error anymore (the
      // #1118 hard error this superseded only existed because the parser
      // didn't support joined forms at all — now that it does, the joined
      // form is just as valid as the space-separated one).
      (result.param ??= []).push(args[++i]);
    } else if (arg === "--params-file") {
      result.paramsFile = args[++i];
    } else if (arg.startsWith("--")) {
      // chant #1127 — every recognized flag is matched above; anything left
      // starting with `--` is unrecognized, whether it arrived bare
      // (`--bogus`) or joined (`--bogus=value`, already split into
      // `--bogus` + `value` above). This used to fall through silently (the
      // "ignores unknown flags" case) — a typo'd or misremembered flag would
      // vanish with no diagnostic, exactly like the silent-drop this issue
      // closes for joined values. Point at --help rather than enumerating
      // every flag here: this parser's flag set is one flat list shared by
      // every command, not scoped per-command, so "the command's known
      // flags" isn't something this loop can name in isolation.
      throw new Error(`Unknown flag: ${arg}\nRun "chant --help" to see supported flags.`);
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
                        (--components --generate gitlab: generate mode (#563) —
                         synthesize a thin .gitlab-ci.yml that triggers each
                         discovered component's own deploy in wave order,
                         instead of a normal lexicon build)
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
  carve advise          Read-only Terraform peelability advisor: rank which
                        --from <tf-dir>   resources are cheap to carve into native chant
                        (--json, --report <path>). Emits nothing, changes nothing.
                        Needs @cdktf/hcl2json (npm install -D @cdktf/hcl2json).
  carve emit            Adopt a selected TF resource into chant source + report
                        --from <tf-dir>   its boundary. --state <tfstate> adopts offline
                        --select <addr>   (recommended for TF-managed resources); --env
                        --state|--env     <env> adopts via live cloud import (--live-name
                                          <logical-id> narrows a multi-resource stack).
  carve bridge          Generate the surviving-TF patch (data sources + rewired
                        --from <tf-dir>   refs) + deferred inputs + reversible runbook.
                        --select <addr>   Writes proposals for review; --apply-rewrites
                                          edits the .tf in place.
  carve apply           Apply graduation: ownership marker + finalized apply
                        --from <tf-dir>   runbook (dial-turn observe→apply). BYOL —
                        --select <addr>   no cloud call; --write saves the doc.
                        --env <env>

Ops:
  run <name>            Start an Op workflow (spawns worker + submits to Temporal)
  run list              List all Ops with current run status
                        --components: list discovered Components instead (--temporal
                        also annotates each with its latest run status; #599)
  run status <name>     Show current workflow run state
                        --components: show a Component's durable run state instead (#599)
  run signal <name> <signal>  Send a named signal to unblock a gate
                        --components: signal a Component's workflow instead (#589)
  run cancel <name>     Cancel the active workflow run (requires --force)
                        --components: cancel a Component's workflow instead (#589)
  run log <name>        Show run history for an Op
                        --components: show a Component's run history instead (#599)
  run --components <name|all>  Run discovered Component(s) through the interpret
                        driver on the local executor (--env <env>; #585).
                        On success, auto-emits a release-ledger record per
                        component that published a digest (default: on;
                        --no-release-record to opt out; #597)
                        --progress-json: stream one NDJSON RunProgressEvent
                        per line to stdout while the run executes, for a
                        consumer to render live wave/component/phase/step
                        progress instead of tailing raw logs (additive; run
                        semantics/exit code unchanged)

  graph                 Show Op dependency graph (--stacks for cross-stack order,
                        --format ir|mermaid|dot|layout for the lint-gated graph IR,
                        a Mermaid flowchart, Graphviz DOT, or node positions;
                        layout uses dagre by default (no native dep) — pass
                        --node-sizes <json|-|@file> for size-aware spacing,
                        --layout-engine graphviz to use dot instead;
                        --detail 0..3: stacks|composites|declarables|attributes;
                        --lens lexicon:<n>|stack:<n>|blast:<node> (--up/--down))

Lifecycle (alias: lc):
  lifecycle snapshot <env>  Query API, save metadata to orphan branch
  lifecycle show <env>      Show latest lifecycle snapshot
  lifecycle diff <env>      Compare current build against last snapshot
                            --live: query cloud now and detect drift
                            (lexicons with a deep reader also report
                            property-level drift; --update-baseline records
                            what it reports as accepted so it stops alerting)
  lifecycle plan <env>      Typed change set (create/update/delete/adopt) vs live
  lifecycle affected        Stacks a change affects (--base <ref> [--include-dependents])
                            --json: emit the ChangeSet as JSON
  lifecycle log [env]       History of lifecycle snapshots

Component release ledger + status:
  components status [env]  What's built vs what's deployed where, joined by
                            digest (--live: reconcile against live+ownership;
                            --json: stable machine-readable contract;
                            --compare-to <env>: cross-check the same
                            component's recorded digest against another env)
  components release <env> Append one immutable release record
                            (--component <name> --digest <sha256:...>
                             [--git-sha <sha>] [--run-id <id>] [--actor <name>])

Lexicon development:
  dev generate          Generate lexicon artifacts (+ validate + coverage)
  dev publish           Package lexicon for distribution
  dev onboard <name>    Patch CI, Dockerfiles, and workflows for a new lexicon
  dev check-lexicon <dir>  Check lexicon completeness (tier 1/2/3)
  dev surface-diff <dir>   Regen lexicon, validate, diff API surface vs committed baseline
                           (--force: bypass spec cache; --update-snapshot: write new baseline;
                            --bump: with --update-snapshot, bump package version by drift severity;
                            --check: fail if the committed baseline drifted (never writes);
                            --run-examples: also run example build harness;
                            --pinned-digest <file>: verify spec digest before regen)
  dev pinned-upgrade <dir> Report if a pinned lexicon (k8s|gcp|docker|gitlab) has a newer
                           upstream release; dry-run bump + regen + surface-diff, then revert
                           (reports only; --force bypasses the spec cache, -f json for JSON)
  dev rolling-upgrade <dir>  Report rolling-spec drift (aws, azure, github): regen from
                           latest, diff surface vs committed baseline, print delta + PR
                           label (dry run; --force bypasses the spec cache, --format json)

Local:
  emulator <up|down|status>  Boot/stop/inspect configured lexicons' local
                           emulators (Floci etc.); --lexicon <name>, --json

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
      --env <name>      Active environment: sets CHANT_ENV so env-aware source
                        re-evaluates for that environment (build + graph), and
                        drives organizational policy. Must be in chant.config
                        \`environments\` when declared.
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
  --components          Target discovered Component declarations instead of
                        lexicon resources (list, describe, graph, build, run)
  --generate <lexicon>  Generate mode (build --components only): synthesize CI
                        YAML for <lexicon> instead of running a normal build.
                        Only "gitlab" is implemented for v1.
  --no-release-record   Skip auto-emitting a release-ledger record after a
                        successful \`run --components\` deploy (default: on;
                        also settable via chant.config.ts's
                        release.autoRecord: false; #597)
  --fold                (build) Fold source modules statically instead of
                        running them; folds resource constructors and
                        composite factory calls (#1022/#1023), falling back
                        to run per-file for anything else outside the fold
                        subset (a cross-file-only reference, a re-export,
                        \`export default\`, ...). Logs which path each file
                        took. DEFAULT since #1134 — this flag forces it on
                        over a chant.config.ts \`build.fold: false\`.
  --no-fold             (build) Opt out of folding for this invocation: every
                        source module is imported and run, the pre-#1134
                        behavior. Beats chant.config.ts's build.fold.
  --sandbox             (build) Run run-fallback source files (or every
                        file, without --fold) together, isolated, in one
                        sandboxed child process instead of in-process
                        (#1045). No filesystem write, no child process, no
                        worker threads, no ambient environment visible to
                        project source; network egress is NOT blocked (see
                        docs). Default: off (also settable via
                        chant.config.ts's build.sandbox: true; #1045)
  --param <name=value>  (build) Bind a declared build-time parameter
                        (chant.config.ts's buildParams) to a value, for
                        source to read as params.<name> (#1064) instead of
                        process.env — repeatable. Distinct from the AWS
                        lexicon's deploy-time Parameter(): this resolves
                        before synthesis, so it can change which resources
                        are produced at all. Highest precedence.
  --params-file <path>  (build) JSON file of { "name": value } build-time
                        parameter values (#1064). Second precedence, after
                        --param.

Examples:
  chant build ./infra/
  chant build ./infra/ --output stack.json
  chant build ./infra/ --format yaml
  chant build ./infra/ --watch
  chant build ./infra/ --fold
  chant build ./infra/ --components --generate gitlab
  chant build ./infra/ --components --generate gitlab --output .gitlab-ci.yml
  chant run --components search-service --env staging
  chant run --components all --env production
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
  // Read-only Terraform peelability advisor (#214). Compound so "advise" lands
  // in args.path; the estate dir comes from --from. No plugins, no project.
  { name: "carve advise", handler: runCarveAdvise },
  // Emit step (#197): adopt a selected TF resource into chant source. The
  // --state path is offline (no plugins); the --env live path loads the target
  // lexicon lazily in the handler, so this command does not require plugins.
  { name: "carve emit", handler: runCarveEmit },
  // Boundary bridging (#197): patch the surviving TF (data sources + rewired
  // refs) + runbook. No plugins; Terraform-side only. Read-only unless
  // --apply-rewrites.
  { name: "carve bridge", handler: runCarveBridge },
  // Apply graduation (#197): ownership marker + finalized apply runbook.
  // BYOL-honest — no cloud call; --write saves the graduation doc.
  { name: "carve apply", handler: runCarveApply },
  { name: "init", handler: runInit },
  { name: "init lexicon", handler: runInitLexicon },
{ name: "update", handler: runUpdate },
  { name: "doctor", handler: runDoctor },

  // Dev subcommands
  { name: "dev generate", requiresPlugins: true, handler: runDevGenerate },
  { name: "dev publish", requiresPlugins: true, handler: runDevPublish },
  { name: "dev onboard", handler: runDevOnboard },
  { name: "dev check-lexicon", handler: runDevCheckLexicon },
  { name: "dev surface-diff", handler: runDevSurfaceDiff },
  { name: "dev pinned-upgrade", handler: runDevPinnedUpgrade },
  { name: "dev rolling-upgrade", handler: runDevRollingUpgrade },

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
  { name: "lifecycle rollback", handler: runLifecycleRollback },
  { name: "lifecycle plan", requiresPlugins: true, handler: runLifecyclePlan },
  { name: "lifecycle affected", requiresPlugins: true, handler: runLifecycleAffected },
  { name: "lifecycle log", handler: runLifecycleLog },

  // Component release ledger + status surface (#568, epic #551)
  { name: "components status", requiresPlugins: true, handler: runComponentsStatus },
  { name: "components release", handler: runComponentsReleaseRecord },

  // Local emulators of configured lexicons (#920). Compound so the action word
  // lands in args.path (not consumed as a project dir) and projectPath is forced ".".
  { name: "emulator up", requiresPlugins: true, handler: runEmulator },
  { name: "emulator down", requiresPlugins: true, handler: runEmulator },
  { name: "emulator status", requiresPlugins: true, handler: runEmulator },

  // Serve subcommands
  { name: "serve lsp", requiresPlugins: true, handler: runServeLsp },
  { name: "serve mcp", requiresPlugins: true, handler: runServeMcp },

  // Fallback for unknown subcommands (must come after compound entries)
  { name: "carve", handler: runCarveUnknown },
  { name: "emulator", requiresPlugins: true, handler: runEmulator },
  { name: "lifecycle", handler: runLifecycleUnknown },
  { name: "dev", handler: runDevUnknown },
  { name: "serve", handler: runServeUnknown },
  { name: "components", handler: runComponentsUnknown },
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

  // `--env <name>` is a build-context switch for the whole invocation: set it
  // *before* anything imports the project so env-aware source (and thus the graph
  // / build) reflects that environment. Set early, before config import, since
  // chant.config itself may branch on the env. (#505)
  if (args.env) process.env[ENV_VAR] = args.env;

  // chant #1113 — `--sandbox` is a property of the whole invocation, and it
  // has to be known BEFORE the first config load, because `chant.config.ts` is
  // itself project-authored code. Arming here, straight off the parsed flag,
  // is the only ordering that works: the project's own `build.sandbox: true`
  // cannot cover its own evaluation (reading it means running it), so the
  // command-line flag is what puts the config inside the boundary. See
  // `../config-sandbox.ts`.
  if (args.sandbox) armSandboxConfigEvaluation();

  // chant #1131 — the same for `lint.policies`. Armed from the flag here so
  // the mode is set for the whole invocation, not just `chant build`; the build
  // command arms it again from the RESOLVED value (a project's own
  // `build.sandbox: true` also sandboxes its policies — unlike the config,
  // policies have no bootstrap limit, since they load long after the config is
  // known). See `../lint/policy-sandbox.ts`.
  if (args.sandbox) armSandboxPolicyExecution();

  // Initialize runtime adapter early — before plugins or commands run.
  // chant #1117 — walks up from `args.path` to the project root: for a
  // subdirectory build/command (`chant build src/<stack> --env prod`) the
  // declared `environments` almost always live in the root `chant.config.ts`,
  // not `args.path` itself.
  const projectPath0 = resolve(args.path === "." ? "." : args.path);
  let loadedConfig;
  try {
    loadedConfig = await loadChantConfigUpward(projectPath0);
    initRuntime();
  } catch {
    // Config may not exist yet (e.g. `chant init`)
    initRuntime();
  }

  // Reject an --env that isn't among the project's declared `environments`.
  const envErr = unknownEnvError(args.env, loadedConfig?.config.environments);
  if (envErr) {
    console.error(formatError({ message: envErr, hint: 'Declare it in chant.config `environments`, or omit --env.' }));
    process.exit(1);
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
  // `chant build --components --generate <lexicon>` (#563, generate mode)
  // discovers `Component` declarations, not lexicon resources — a project
  // made entirely of components has no reason to declare a chant lexicon
  // plugin at all. Load plugins best-effort here instead of exiting, so
  // generate mode works whether or not `chant.config.ts` names a lexicon.
  // `components status` (#568) is the same shape: a components-only project
  // may have no lexicon plugin, and `--live` reconciliation is opt-in, so
  // missing plugins there is "no live evidence" (a warning), not a hard exit.
  const isGenerateComponents = match.def.name === "build" && args.components && !!args.generate;
  const isComponentsStatus = match.def.name === "components status";
  // `emulator` (#920) is a property of the *configured* lexicons, not of any infra
  // file — a fresh/local project with no declarables still boots Floci. Load from
  // chant.config best-effort, like components status, rather than detectLexicon.
  const isEmulator = match.def.name === "emulator" || match.def.name.startsWith("emulator ");
  const plugins = match.def.requiresPlugins
    ? isGenerateComponents || isComponentsStatus || isEmulator
      ? await loadPlugins(await resolveProjectLexicons(resolve(projectPath)).catch(() => [])).catch(() => [])
      : await loadPluginsOrExit(projectPath)
    : [];
  const serializers = plugins.map((p) => p.serializer);
  const ctx = { args, plugins, serializers };

  await flushAndExit(await match.def.handler(ctx));
}

/**
 * Wait until a writable stream has flushed its buffer. `process.exit()` discards
 * data still buffered for an async sink (a pipe or file), truncating large output
 * at the ~64 KB pipe buffer — so `chant graph --format ir` piped into a consumer
 * loses everything past 64 KB and its JSON won't parse. A TTY writes
 * synchronously (`writableLength` stays 0), so this is a no-op there. Resolves on
 * `error`/`close` too, so a reader that closes early (EPIPE) can't hang exit.
 * Exported for testing.
 */
export function waitForStreamDrain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      if (stream.writableLength === 0 || stream.writableEnded || stream.destroyed) {
        cleanup();
        resolve();
        return;
      }
      stream.once("drain", tick);
    };
    const stop = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      stream.off("drain", tick);
      stream.off("error", stop);
      stream.off("close", stop);
    };
    stream.once("error", stop);
    stream.once("close", stop);
    tick();
  });
}

/** Flush stdout+stderr, then exit — so a large piped payload isn't truncated. */
async function flushAndExit(code: number): Promise<never> {
  await waitForStreamDrain(process.stdout);
  await waitForStreamDrain(process.stderr);
  process.exit(code);
}

// Only run main when executed directly, not when imported. Robust to symlinked
// invocation paths — see isEntryPoint (a raw string compare silently no-ops the
// whole CLI through the npm .bin shim / a symlinked checkout).
const isMain = isEntryPoint(process.argv[1], import.meta.url);
if (isMain) {
  main().catch(async (err) => {
    const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
    if (verbose && err instanceof Error && err.stack) {
      console.error(err.stack);
    } else {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    }
    await flushAndExit(1);
  });
}
