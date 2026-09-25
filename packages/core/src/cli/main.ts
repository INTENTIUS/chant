#!/usr/bin/env tsx

import { resolve } from "node:path";
import { isEntryPoint } from "./is-entry-point";
import { formatSuccess, formatError } from "./format";
import { loadPlugins, resolveProjectLexicons } from "./plugins";
import { resolveCommand, type CommandDef, type ParsedArgs } from "./registry";
import { loadChantConfigUpward } from "../config";
import { findProjectRoot, findWorkspaceRoot } from "../project-root";
import { isNoLexiconDetected } from "../detectLexicon";
import { CHANT_VERSION } from "./version";
import { validateLexiconConfig, formatLexiconConfigProblems } from "../lexicon-config";
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
import { runCarveStatus } from "./handlers/carve-status";
import { runLifecycleSnapshot, runLifecycleShow, runLifecycleDiff, runLifecycleRollback, runLifecyclePlan, runLifecycleAffected, runLifecycleLog, runLifecycleTeardown, runLifecycleWhoami, runLifecycleUnknown } from "./handlers/lifecycle";
import { runComponentsStatus, runComponentsReleaseRecord, runComponentsExport, runComponentsUnknown } from "./handlers/components";
import { runComponentsFanOut } from "./handlers/fan-out";
import { runComponentsPromote, runComponentsRollback, runComponentsRedeploy } from "./handlers/promote";
import { runScenarioCheck, runScenarioUnknown } from "./handlers/scenario";
import { runGraph } from "./handlers/graph";
import { runExplain } from "./handlers/explain";
import { runSearch } from "./handlers/search";
import { runOp, runOpList, runOpStatus, runOpApprove, runOpSignalRenamed, runOpCancel, runOpLog } from "./handlers/run";
import { runOperator, runOperatorStatus, runOperatorLog, runApprove } from "./handlers/operator";
import { runEmulator } from "./handlers/emulator";
import { splitJoinedFlags, dispatchCommandGroup, collectCommandGroups, formatCommandGroupsHelp, type CommandGroup } from "./command-group";
import type { LexiconPlugin } from "../lexicon";

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
  "--version",
  "--agents",
  "--agent",
  "--all-projects",
  "--force",
  "--fix",
  "--watch",
  "--verbose",
  "--live",
  "--overlay",
  "--explain",
  "--owned",
  "--verbatim",
  "--apply-rewrites",
  "--write",
  "--strict",
  "--validate",
  "--use-composites",
  "--composites",
  "--stacks",
  "--components",
  "--up",
  "--down",
  "--include-dependents",
  "--local",
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
  "--yes",
  "--confirm-prod",
  "--once",
  "--expire",
  "--check-live",
  "--check-snapshot",
  "--fail-on-drift",
  "--durable-requests",
  "--skip-mcp",
  "--current",
  "--allow-code",
  "--root-only",
  "--generated",
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
    param: undefined,
    paramsFile: undefined,
    report: undefined,
    local: undefined,
    profile: undefined,
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
    skipMcp: undefined,
    src: undefined,
    env: undefined,
  };

  // chant #1127 — generic joined `--flag=value` support, factored out to
  // ./command-group.ts (chant #1078) so a lexicon's own mounted command can
  // apply the identical splitting discipline to its own flag vocabulary.
  // Every value-taking flag below is matched by an exact `arg === "--flag"`
  // check and then consumes the *next* array element (`args[++i]`) as its
  // value; a joined token like `--env=prod` never matches any of those,
  // doesn't match the trailing positional branch either (it starts with
  // `-`), and used to vanish with no error. Splitting the token at its FIRST
  // `=` and re-dispatching as two array elements makes every flag below see
  // the exact shape it already handles — including a flag like `--param`
  // whose own value legitimately contains `=` (`--param=tier=production`
  // splits to flag `--param`, value `tier=production`, not further split on
  // the second `=`).
  args = splitJoinedFlags(args, BOOLEAN_FLAGS);

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--version" || arg === "-V") {
      result.version = true;
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
    } else if (arg === "--traffic") {
      const v = args[++i];
      if (!v) throw new Error('--traffic needs a level, passed to the engine verbatim: --traffic "100 rps, p50"');
      result.traffic = v;
    } else if (arg === "--overlay-anchor") {
      const v = args[++i];
      if (v !== "source" && v !== "live") throw new Error(`--overlay-anchor must be 'source' or 'live', got '${v}'`);
      result.overlayAnchor = v;
    } else if (arg === "--from") {
      // Shared by `migrate --from <lexicon>`, `import --from <env>`,
      // `components promote --from <env>` and `init --from <repo>@<ref>`;
      // the commands never run together, so one field carries all four.
      result.migrateFrom = args[++i];
    } else if (arg === "--kustomize") {
      // `chant import --kustomize <dir>` (#1548): render the overlay, import
      // the output through the k8s template parser.
      result.kustomize = args[++i];
    } else if (arg === "--type") {
      result.selectType = args[++i];
    } else if (arg === "--name") {
      result.selectName = args[++i];
    } else if (arg === "--owned") {
      result.owned = true;
    } else if (arg === "--namespace") {
      // The live read's namespace default (#1629), not a kubectl `-n`: it fills
      // in for entities that declare no namespace and leaves the ones that do
      // alone. No `-n` short form — that spelling belongs to `chant kube`,
      // where it means kubectl's scope selector.
      result.namespace = args[++i];
      if (!result.namespace || result.namespace.startsWith("-")) throw new Error("--namespace needs a namespace: --namespace <ns>");
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
    } else if (arg === "--write-source") {
      result.writeSource = true;
    } else if (arg === "--to") {
      result.migrateTo = args[++i];
    } else if (arg === "--emit") {
      result.emit = args[++i];
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--yes") {
      result.yes = true;
    } else if (arg === "--confirm-prod") {
      result.confirmProd = true;
    } else if (arg === "--strict") {
      result.strict = true;
    } else if (arg === "--validate") {
      result.validate = true;
    } else if (arg === "--use-composites") {
      result.useComposites = true;
    } else if (arg === "--skill") {
      result.skill = args[++i];
    } else if (arg === "--skip-mcp") {
      result.skipMcp = true;
    } else if (arg === "--src") {
      result.src = args[++i];
    } else if (arg === "--env") {
      result.env = args[++i];
    } else if (arg === "--promote-to") {
      result.promoteTo = args[++i];
      if (!result.promoteTo || result.promoteTo.startsWith("-")) throw new Error("--promote-to needs an environment: --promote-to <env>");
    } else if (arg === "--tier") {
      result.tier = args[++i];
    } else if (arg === "--agents") {
      result.agents = true;
    } else if (arg === "--scope") {
      result.scope = args[++i];
    } else if (arg === "--all-projects") {
      result.allProjects = true;
    } else if (arg === "--runtime") {
      result.runtime = args[++i];
    } else if (arg === "--fail-on") {
      result.failOn = args[++i];
    } else if (arg === "--max-files") {
      // Validated by the audit handler, like `--limit` below.
      result.maxFiles = Number(args[++i]);
    } else if (arg === "--theme") {
      result.theme = args[++i];
    } else if (arg === "--stacks") {
      result.stacks = true;
    } else if (arg === "--components") {
      result.components = true;
    } else if (arg === "--generate") {
      result.generate = args[++i];
    } else if (arg === "--spec") {
      result.opsSpec = args[++i];
    } else if (arg === "--dump-outputs") {
      result.dumpOutputs = args[++i];
    } else if (arg === "--digest-file") {
      result.digestFile = args[++i];
    } else if (arg === "--seed-outputs") {
      (result.seedOutputs ??= []).push(args[++i]);
    } else if (arg === "--detail") {
      result.detail = Number(args[++i]);
    } else if (arg === "--lens") {
      result.lens = args[++i];
    } else if (arg === "--explain") {
      result.explain = true;
    } else if (arg === "--show") {
      result.show = args[++i];
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
    } else if (arg === "--from-affected") {
      result.fromAffected = args[++i];
    } else if (arg === "--gate") {
      result.gate = args[++i];
    } else if (arg === "--resume") {
      result.resume = args[++i];
    } else if (arg === "--local") {
      result.local = true;
    } else if (arg === "--json") {
      result.json = true;
    } else if (arg === "--progress-json") {
      result.progressJson = true;
    } else if (arg === "--gated-exit") {
      // `chant run <op> --gated-exit <code>` (#2243) — remap only the gated
      // outcome's exit code. Parsed as a number here and range-checked in the
      // handler, where the refusal can name the flag alongside the run.
      result.gatedExit = Number(args[++i]);
    } else if (arg === "--durable-requests") {
      // `chant run approve ... --on <lexicon> --durable-requests` (#2126) —
      // resolve the gate on the hosting runtime's own request path rather
      // than by posting a follow-up prompt. Core only carries the flag; the
      // runtime decides whether it has such a path.
      result.durableRequests = true;
    } else if (arg === "--update-snapshot") {
      result.updateSnapshot = true;
    } else if (arg === "--update-baseline") {
      result.updateBaseline = true;
    } else if (arg === "--deep") {
      result.deep = true;
    } else if (arg === "--at") {
      result.at = args[++i];
    } else if (arg === "--kind") {
      // `chant workspace records|graph|check --kind <kind file>` (#2546, #2549)
      result.kind = args[++i];
      if (!result.kind || result.kind.startsWith("-")) throw new Error("--kind needs a kind file: --kind <path>");
      // Repeatable for `workspace graph --intent` (#2651); the others read the last one.
      (result.kinds ??= []).push(result.kind);
    } else if (arg === "--composites") {
      // `chant workspace graph --composites` (#2662)
      result.composites = true;
    } else if (arg === "--intent") {
      // `chant workspace graph --intent <path[:start-end]>` (#2651)
      result.intent = args[++i];
      if (!result.intent || result.intent.startsWith("-")) throw new Error("--intent needs a region: --intent <path[:start-end]>");
    } else if (arg === "--current") {
      result.current = true;
    } else if (arg === "--set") {
      // `chant workspace records amend <id> --set <file|->` (#2670)
      result.set = args[++i];
      if (!result.set || (result.set.startsWith("-") && result.set !== "-")) throw new Error("--set needs a JSON file, or - for standard input: --set <file|->");
    } else if (arg === "--verdict") {
      // `chant workspace records review <id> --verdict agree|dissent|abstain` (#2670)
      result.verdict = args[++i];
      if (!result.verdict || result.verdict.startsWith("-")) throw new Error("--verdict needs agree, dissent or abstain");
    } else if (arg === "--by") {
      // `chant workspace records review <id> --by <principal>` (#2670): whoever the caller says.
      result.by = args[++i];
      if (!result.by || result.by.startsWith("-")) throw new Error("--by needs the reviewer: --by <principal>");
    } else if (arg === "--sign") {
      // `chant workspace records review <id> --sign [<key file>]` (#2687): seal the verdict.
      // `records new` and `records amend` take it too, to seal the record's author (#2688).
      // With no key file, git's user.signingkey, as `git commit -S` reads it.
      const next = args[i + 1];
      result.sign = next !== undefined && !next.startsWith("-") ? args[++i] : true;
    } else if (arg === "--session") {
      // `chant workspace records review <id> --session <id>` (#2670)
      result.session = args[++i];
      if (!result.session || result.session.startsWith("-")) throw new Error("--session needs a session id: --session <id>");
    } else if (arg === "--prefix") {
      // `chant workspace records new <kind> --prefix <prefix>` (#2670): the id prefix to allocate under.
      result.prefix = args[++i];
      if (!result.prefix || result.prefix.startsWith("-")) throw new Error("--prefix needs an id prefix: --prefix <prefix>");
    } else if (arg === "--require") {
      // `chant workspace records|verify --require attested` (#2547)
      result.require = args[++i];
      if (!result.require || result.require.startsWith("-")) throw new Error("--require needs a provenance level: --require attested");
    } else if (arg === "--ambient") {
      result.ambient = true;
    } else if (arg === "--check-live") {
      result.checkLive = true;
    } else if (arg === "--check-snapshot") {
      result.checkSnapshot = true;
    } else if (arg === "--fail-on-drift") {
      result.failOnDrift = true;
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
      if (result.digest !== undefined) (result.digests ??= []).push(result.digest);
    } else if (arg === "--git-sha") {
      result.gitSha = args[++i];
    } else if (arg === "--run-id") {
      result.runId = args[++i];
    } else if (arg === "--actor") {
      result.actor = args[++i];
    } else if (arg === "--approver") {
      result.approver = args[++i];
    } else if (arg === "--on") {
      // `chant run ... --on <lexicon>` (#2121) — which runtime hosts the run.
      result.on = args[++i];
      if (!result.on || result.on.startsWith("-")) throw new Error("--on needs a runtime name: --on <lexicon>");
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
    } else if (arg === "--fold-rank") {
      // chant #1083 — same context-sensitive shape as --report above:
      // `--fold-rank` alone prints the ranked-blocker report; `--fold-rank
      // <path>` ALSO writes the Brendan Gregg collapsed-format export there.
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        result.foldRankCollapsedFile = next;
        i++;
      } else {
        result.foldRank = true;
      }
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
    } else if (arg === "--projection") {
      result.projection = args[++i];
    } else if (arg === "--interval") {
      result.interval = args[++i];
    } else if (arg === "--lease-ttl") {
      result.leaseTtl = args[++i];
    } else if (arg === "--once") {
      result.once = true;
    } else if (arg === "--note") {
      result.note = args[++i];
    } else if (arg === "--expire") {
      result.expire = true;
    } else if (arg === "--role") {
      // #2508 — a role the approver holds, for a gate whose quorum names
      // roles. Repeatable, and a comma list works too.
      const value = args[++i] ?? "";
      result.roles = [...(result.roles ?? []), ...value.split(",").map((r) => r.trim()).filter(Boolean)];
    } else if (arg === "--agent") {
      // #2508 — record the approval as an agent's rather than a person's.
      result.agent = true;
    } else if (arg === "--allow-code") {
      // #2550 — `chant workspace upgrade` runs a template's code migrations
      // only when asked to.
      result.allowCode = true;
    } else if (arg === "--root-only") {
      // #2537 — `chant build` and `chant lint` at a declared workspace root
      // run on the root project alone instead of refusing with WSP000.
      result.rootOnly = true;
    } else if (arg === "--generated") {
      // #2641 — `chant workspace check --generated` runs each declared
      // generator and compares its output with the file in the tree.
      result.generated = true;
    } else if (arg === "--member") {
      // #2537 — `chant workspace build|lint|audit|graph --member <name>`.
      // Repeatable, and a comma list works too.
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("--member needs a member or group name: --member <name>");
      result.members = [...(result.members ?? []), ...value.split(",").map((m) => m.trim()).filter(Boolean)];
    } else if (arg === "--allow-same-origin") {
      // chant#2384 — record a resolution the same-origin rule would refuse,
      // deliberately. Flagged on the record, not just accepted quietly.
      result.allowSameOrigin = true;
    } else if (arg === "--plan") {
      result.plan = args[++i];
    } else if (arg === "--url") {
      result.url = args[++i];
    } else if (arg === "--op") {
      result.op = args[++i];
    } else if (arg === "--since") {
      result.since = args[++i];
    } else if (arg === "--limit") {
      // Parsed here, validated by the handler — `parseArgs` reports shape, not
      // policy, the same split every other value flag here uses.
      result.limit = Number(args[++i]);
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

  // #2603 — `--promote-to` (#2575) adds a job to the pipeline that generate
  // mode synthesizes; no other command or mode reads it. Checked here, once
  // the whole command line is known, rather than in the build handler, so
  // `chant build --promote-to prod` and `chant run --promote-to prod` both
  // fail instead of running as if the flag were absent. A lexicon-mounted
  // command that takes its own `--promote-to` still gets it: `main` tries the
  // plugin commands before rethrowing a parse error.
  if (result.promoteTo && !(result.command === "build" && result.components && result.generate)) {
    throw new Error(
      "--promote-to needs build --components --generate <lexicon>: it adds a promote job to the generated CI pipeline, and only generate mode emits one.",
    );
  }

  return result;
}

/**
 * Print help message. `groups` — lexicon-contributed command groups
 * (chant #1078), best-effort loaded from the current project; composed in
 * below the static command list so `--help` lists every mounted verb group
 * alongside core's own commands.
 */
function printHelp(groups: CommandGroup[] = []): void {
  console.log(`
chant - Declarative infrastructure specification toolkit

Usage:
  chant <command> [options] [path]

Commands:
  init                  Initialize a new chant project
                        (--from <repo>@<ref>[#<member>] copies a template
                        repository and records its lineage, and --from
                        <dir>[#<member>] copies a template directory on
                        disk; --param
                        <name>=<value> sets a parameter the template's
                        chant.template.json declares, repeatable)
  init lexicon <name>   Scaffold a new lexicon plugin project
  build                 Build infrastructure from specification files
                        (--components --generate github|gitlab|forgejo:
                         generate mode (#563), which synthesizes a thin CI
                         pipeline that triggers each discovered component's
                         own deploy in wave order, instead of a normal
                         lexicon build)
                        At a declared workspace root it refuses with WSP000;
                        --root-only builds the root project alone
  lint                  Check specifications for issues
                        (at a declared workspace root: WSP000 unless --root-only)
  list                  List discovered entities
  describe              Show the effective config for one component
  explain               Summarize discovered entities (--format markdown|json|okf;
                        okf emits an OKF v0.2 knowledge bundle — one markdown
                        concept per entity + index.md; -o <dir> writes the
                        bundle tree, otherwise JSON path→content on stdout)
  vendor                Pull pinned, checksummed patterns into your repo
                        (pull [name] | check | migrate; migrate moves
                        vendor.json into .chant/workspace.lock.json)
  import                Import external template into TypeScript
                        (--agents re-expresses this machine's agent config as
                         chant code instead of reading a template file)
  audit [path|url]      Audit a repo's CI YAML for security issues
                        (--format stylish|json|sarif|markdown|html, -o <file>,
                         --tier merge-worthy|all, --fail-on merge-worthy|warning|error|none,
                         --template <file> / --theme <file> for the html report,
                         --max-files <n> to walk more than 1000 files)
                        --agents audits this machine's agent configuration —
                        instruction files, MCP servers, skills, plugins,
                        permissions — instead of a repository
                        (--scope system,user,project, --runtime claude,codex,...,
                         --all-projects)
  migrate <file>        Translate a workflow between lexicons
                        (default: --from github --to gitlab)
  carve advise          Read-only peelability advisor: rank which resources
                        --from <dir>      are cheap to carve into native chant
                        (--json, --report <path>). Emits nothing, changes nothing.
                        --from a Terraform dir needs @cdktn/hcl2json
                        (npm install -D @cdktn/hcl2json); --from a CDK cloud
                        assembly (cdk.out) needs nothing and ranks constructs.
  carve emit            Adopt a selected TF resource into chant source + report
                        --from <tf-dir>   its boundary. --state <tfstate> adopts offline
                        --select <addr>   (recommended for TF-managed resources); --env
                        --state|--env     <env> adopts via live cloud import (--live-name
                                          <logical-id> narrows a multi-resource stack).
                                          Persists a carve manifest bridge/apply compose
                                          with; scaffolds the output dir into a buildable
                                          chant project (src/ + config + package.json).
  carve bridge          Generate the surviving-TF patch (data sources + rewired
                        --from <tf-dir>   refs) + deferred inputs + reversible runbook,
                        [--select <addr>] plus one git-applyable .patch for the whole
                                          edit. Writes proposals for review;
                                          --apply-rewrites edits the .tf in place.
                                          --select is optional when the output dir
                                          holds one carve manifest.
  carve apply           Apply graduation: ownership marker + finalized apply
                        --from <tf-dir>   runbook (dial-turn observe→apply). BYOL —
                        [--select <addr>] no cloud call; --write saves the doc. --select
                        --env <env>       is optional with a carve manifest present.
                                          --write-source stamps the ownership marker
                                          into the emitted chant source.
  carve status          Status read over a tree of carve manifests: every
                        [--from <dir>]    *.carve.json under --from (default: cwd) with
                        (--json)          its target, stage (planned/emitted/bridged/
                                          applied) and path. Read-only.

Ops:
  run <name>            Run an Op on the resolved runtime (--on; local by default)
  run list              List all Ops with the runtime's state for each
  run status <name>     Show the runtime's state for one Op's latest run
  run approve <op> <gate>  Record a gate's resolution and wake the runtime
  run cancel <name>     Cancel the active run (requires --force)
  run log <name>        Show run history for an Op
  run --generate <provider>  Write one CI pipeline file per scheduled Op for
                        github, gitlab or forgejo (#2533), from every Op that
                        declares a schedule or from --spec <file.json>.
                        Files go to the forge's own directory unless
                        --output <dir>; --format json prints them instead
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
  operator               Run scheduled ticks for discovered ConvergeOps
                        locally (#1485): acquire/renew a per-op
                        lease (git ref CAS), tick on --interval, record every
                        result as a ledger fact. --env <env> scopes to one
                        environment; --interval <dur> (default 60s) and
                        --lease-ttl <dur> (default 5m) tune cadence; --once
                        runs a single round and exits (cron/systemd-timer/
                        CronJob invokers use this instead of the daemon)
  operator status        Last tick, outcomes, and pending gates per
                        ConvergeOp, read from the chant/lifecycle orphan
                        branch alone — no daemon needs to be running
                        (--env <env>, --json)
  operator log           Converge tick history and the gate resolutions
                        against it, merged into one timestamp-ordered
                        timeline, from the same orphan branch (--env <env>,
                        --op <name>, --since <iso>, --limit <n>, --json).
                        --json also carries the count of ledger lines that
                        were unreadable, so a short timeline is never
                        silently short
  approve <op> <gate>    Record a gate's out-of-band resolution fact
                        (--actor <name>, --note <text>, --url <url>) — the
                        durable counterpart to the pending fact a run records
                        when it reaches the gate; see the pending-gates list
                        in operator status. --url is the PR/MR the resolution
                        happened at, recorded typed rather than as free text,
                        and defaults to the PR/MR of the surrounding CI job.
                        The next "chant run <op>" walks through the gate.
                        --expire clears a pending fact without approving it,
                        so the gate is re-decided from scratch next run

  graph                 Show Op dependency graph (--stacks for cross-stack order,
                        --format ir|mermaid|dot|layout for the lint-gated graph IR,
                        a Mermaid flowchart, Graphviz DOT, or node positions;
                        layout uses dagre by default (no native dep) — pass
                        --node-sizes <json|-|@file> for size-aware spacing,
                        --layout-engine graphviz to use dot instead;
                        --detail 0..3: stacks|composites|declarables|attributes;
                        --lens lexicon:<n>|stack:<n>|blast:<node> (--up/--down))
                        --components --format ir --projection gitlab|github|forgejo:
                        add the CI/pipeline projection (stages/jobs/needs) to
                        the component-graph IR, from the same generator
                        'build --components --generate' uses (#989)
                        --traffic "<level>": ask the project's predicting
                        lexicon what the estate does at that traffic level, and
                        carry each entity's prediction on the IR. On the
                        declared graph it predicts the file; with --live it
                        predicts the account. The level reaches the engine
                        verbatim; without the flag nothing is asked (#2377)

Workspace (level 1, #2524):
  workspace init [dir]  Propose a chant.workspace.json from the projects and
                        packages already in the repository, print it with the
                        directories that would leave the root project, and
                        write it only on confirmation (--yes writes without
                        asking; --name <name> names the workspace; --verbose
                        lists every file leaving the root project)
  workspace ls [dir]    List the declaration's members and example groups.
                        A member that can't be read is listed with a reason
                        code and still exits 0. --at <rev> reads a commit's
                        git objects; --json prints the read-contract document
  workspace status <env> [dir] [--compare-to <env>] [--json]
                        Each member's latest release in <env>, as digest and
                        git SHA, read from its ledger on the local
                        chant/lifecycle branch (_members/<member>/ or the flat
                        layout). --compare-to <env> shows a second environment
                        beside it and marks the members whose digests differ.
                        Read only; never fetches. --json prints the
                        read-contract document
  workspace records [--kind <kind file>] [--current] [--at <rev>] [--base <rev>] [--require attested] [--json]
                        Without --kind, every record kind the declaration
                        names. Read the records a record kind locates, validated
                        against its schema, with reason codes for invalid
                        ones. --current leaves out superseded records; --at
                        reads a commit's git objects. Needs no workspace file.
                        Each record reports its provenance level, judged by
                        the signers at --base (default: the target branch);
                        --require attested exits 2 if any record is not
                        attested. A pinned file that changed is a warning,
                        asset-drift or asset-missing
  workspace records [--kind <kind file>] --since <rev|session id> [--at <rev>] [--json]
                        What changed in the records between <rev> and --at
                        (default: the working tree): new and removed records,
                        state transitions, new verdicts, new supersessions
                        and changed pins. A session id compares the commits
                        the session opened and closed at
  workspace records pin <path>
                        Print the path from the workspace root and the
                        sha256 of a file, for a decision's evidence pin
  workspace records new [<kind file>] --from <file|-> [--prefix <prefix>] [--sign [<key file>]] [--dry-run]
                        Write one new record in the kind's directory from
                        the JSON fields given, after validating them as
                        records would read them. Without a kind file, the one
                        kind the declaration names. Allocates the next id when
                        the fields hold none. --sign seals the record's author
                        (decided_by for decisions) with an ssh key. Prints
                        {path, id} as JSON and never commits
  workspace records amend <id> [--kind <kind file>] --set <file|-> [--sign [<key file>]] [--dry-run]
                        Set top-level fields of one record. A closed record
                        never changes, and an approved one changes only its
                        state (upward), pins and reviews; anything else is
                        refused with amend-supersede-instead. --sign seals
                        the author again; without it an amendment removes
                        the author seal and says so. Prints
                        {path, id, changed}
  workspace records review <id> [--kind <kind file>] --verdict agree|dissent|abstain --by <principal> [--note <text>] [--session <id>] [--sign [<key file>]] [--dry-run]
                        Append a review to one record, dated and bound to
                        the digest of the record text. A dissent needs
                        --note. --sign seals it with an ssh key (git's
                        user.signingkey without a file); under a signers
                        file at base only a sealed verdict counts. With
                        --session, the session must be open, and the verdict
                        is appended to its verdicts too. Prints
                        {path, id, review}
  workspace records close <session id> [--kind <session kind file>] [--dry-run]
                        Close an open review session: its state, close time,
                        closing commit and seal, in one write. Without
                        --kind, the one session kind the declaration names.
                        Prints {path, id, changed, seal, closedRev}
  workspace verify [--base <rev>] [--head <rev>] [--require attested]
                        Check the commits in base..head against the signers
                        and roles read from base. A change to the signers file
                        or .chant/trust.json needs a signature by a signer
                        trusted at base. Does nothing without a signers file
  workspace lineage [--json]
                        Show each scope in .chant/workspace.lock.json: its
                        template and pin, locally edited files and open
                        manual steps. Needs no workspace file
  workspace lineage resolve <path>
                        Close a manual step once the file is merged by hand
  workspace upgrade [<scope>] [--to <ref|dir>] [--allow-code] [--dry-run] [--output <file>]
                        Bring a lineage scope to a newer template version: fetch
                        it, migrate and merge per file in a worktree, run build,
                        lint and workspace check there, then gate on the digest
                        of the patch (chant approve workspace-upgrade <scope>).
                        A second run with the approval applies the patch
  workspace check [--at <rev>] [--json] [--format stylish|json|sarif] [--generated] [--kind <kind file>]
                        Fail on an unreadable lineage lock or an open manual
                        step, and, in a declared workspace, on a WSP check of
                        the declaration, member ledgers, pipelines or
                        generated files. --generated runs declared generators
                        and compares their output. --kind warns on records
                        whose pinned files changed. Needs no workspace file.
                        --at reads a commit's git objects; --format json
                        prints the read-contract document
  workspace build [dir] [--member <name>] [-o <dir>] [--dry-run]
                        Build every chant member and example project, each with
                        its own chant, one process per toolchain. -o <dir>
                        writes <dir>/<member>.json; --member narrows the run;
                        --dry-run prints which chant runs which project
  workspace lint [dir] [--format stylish|json|sarif] [--member <name>]
                        Lint every chant member and example project with its
                        own chant; sarif writes one run per member
  workspace audit [dir] [--json] [--member <name>]
                        Audit each chant member with its own .chant-audit.json;
                        every finding carries a member field
  workspace graph [dir] [--at <rev>] [--member <name>] [--kind <kind file>] [-o <file>]
                        Compose each chant member's chant graph into one IR,
                        with <member>/<id> ids and groups.byMember: the
                        read-contract document. --at <rev> runs each member's
                        source as it was at that commit; --kind adds the
                        records' asset and constrains links
  workspace graph --composites [--at <rev>] [--member <name>] [-o <file>]
                        Each composite instance the members declare, with the
                        components whose contract can deploy it; an instance
                        with none lists an empty set
  workspace graph --intent <path[:start-end]> [--at <rev>] [--kind <kind file>...] [--json]
                        The intent graph over one region: the commits that
                        touched it, the decisions whose constrains cover it,
                        the artifacts they pin, and findings with closed codes.
                        Without --kind, every record kind the declaration names

Lifecycle (alias: lc):
  lifecycle snapshot <env>  Query API, save metadata to orphan branch
                            --deep: also record each resource's property tree,
                            not just its identity — what a fold over topology
                            needs (costs more provider calls; #1267)
  lifecycle show <env>      Show latest lifecycle snapshot
  lifecycle diff <env>      Compare current build against last snapshot
                            --live: query cloud now and detect drift
                            (lexicons with a deep reader also report
                            property-level drift; --update-baseline records
                            what it reports as accepted so it stops alerting)
  lifecycle plan <env>      Typed change set (create/update/delete/adopt) vs live
                            --deep: also report properties declared
                            heldElsewhere(). Never changes what the plan
                            proposes; costs a provider call pair per readable
                            resource, so the read's cost becomes a function of
                            estate size rather than stack count (#2405)
  lifecycle affected        Stacks a change affects (--base <ref> [--include-dependents])
                            --json: emit the ChangeSet as JSON
  lifecycle whoami <env>    Who chant would act as in each configured lexicon,
                            and what that principal is scoped to — read-only,
                            before anything acts (--json, --strict)
  lifecycle teardown <env>  Plan what deleting the environment would remove —
                            marker-scoped (this project's stack + env); --yes
                            executes the plan (production-like names also need
                            --confirm-prod, or an interactive confirmation)
  lifecycle log [env]       History of lifecycle snapshots

Plan scenarios (#1292):
  scenario check            Evaluate every declared Scenario's expect clause
                            offline, against its given fixture (no cloud, no
                            credentials); --json: emit verdicts as JSON.
                            Nonzero exit on any failing scenario.

Component release ledger + status:
  components status [env]  What's built vs what's deployed where, joined by
                            digest (--live: reconcile against live+ownership;
                            --json: stable machine-readable contract;
                            --compare-to <env>: cross-check the same
                            component's recorded digest against another env)
  components fan-out       Run a change out across the components downstream
                            of it, in an order derived from the source
                            (--base <ref> [--head <ref>] [--include-dependents],
                             or --from-affected <file>; --dry-run prints the
                             derivation and dispatches nothing; --gate <name>
                             puts one approval over the whole set; --resume
                             <file> finishes an attempt that stopped)
  components release <env> Append one immutable release record
                            (--component <name> --digest <sha256:...>
                             [--git-sha <sha>] [--run-id <id>] [--actor <name>])
  components export <env>  Materialize a persisted build archive manifest to
                            a portable directory (--component <name>
                            [--digest <manifestDigest>] -o <dir> [--json]);
                            copies every image/template/asset/sbom entry
                            byte-for-byte plus a self-describing manifest.json
  components promote        Deploy the digests one environment's release
                            ledger records to another, without a build
                            (--from <env> --to <env> [--component <name>
                             [--digest <sha256:...>]]; --dry-run prints the
                             plan; the target's gates still apply)
  components rollback <env> Redeploy an earlier release of an environment
                            from its recorded digest (--component <name>
                            [--digest <sha256:...>]; defaults to the release
                            before the current one; --dry-run prints the plan)
  components redeploy <env> Redeploy the release an environment's ledger
                            records as current, after a deploy that failed
                            partway (--component <name> [--digest <sha256:...>];
                            --dry-run prints the plan; gates still apply)

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
  -t, --template <name> Init template (e.g. node-pipeline, docker-build);
                        records its lineage in .chant/workspace.lock.json
  --skill <name>        Init: install only this skill from the lexicon
  --skip-mcp            Init: scaffold without writing the project's .mcp.json
  --fix                 Auto-fix fixable issues (lint command)
  --force               Force overwrite existing files (import command)
  -w, --watch           Watch for changes and rebuild/re-lint (build, lint)
  -v, --verbose         Show stack traces on errors; (build) list every
                        resolved build parameter and per-file fold decision
                        instead of the one-line summaries
  -h, --help            Show this help message
  -V, --version         Print the installed chant's version
  --on <lexicon>        Which runtime hosts the run: a configured lexicon with
                        an opRuntime, or the built-in local runtime when
                        omitted (every run subcommand; #2121)
  --local               Run an Op with the local in-process executor (default)
  -p, --profile <name>  Named connection profile the hosting runtime targets
                        (fountain.profiles in chant.config.ts); each runtime's
                        own default when omitted (#2124)
  --json                Emit the structured run result as JSON (run command)
  --report              With a path arg: SARIF report destination (migrate)
                        OR '--report gitlab-mr': emit the GitLab MR plan-widget
                        JSON (lifecycle plan)
                        OR '--report markdown': emit a reviewer-facing markdown
                        render, holes and disruption included (lifecycle plan)
  --from <name>         Source lexicon for migrate (default: github)
  --to <name>           Target lexicon for migrate (default: gitlab)
  --emit <fmt>          Migration output format: yaml (default) or ts
  --strict              Escalate needs-review/validation to errors (migrate);
                        exit nonzero on an unresolved identity (lifecycle whoami)
  --validate            Run external validator (glci/glab) after migrate
  --use-composites      Rewrite to composite calls when patterns match (migrate)
  --components          Target discovered Component declarations instead of
                        lexicon resources (list, describe, graph, build, run)
  --generate <lexicon>  Generate mode: synthesize CI YAML for <lexicon> (github,
                        gitlab or forgejo) instead of running. build
                        --components: one pipeline for the components; run:
                        one pipeline file per scheduled Op
  --spec <file>         (run --generate) JSON Op specs: an array, or
                        { ops, options }
  --promote-to <env>    (build --components --generate) Add a job that
                        promotes the deployed releases to <env>
  --no-release-record   Skip auto-emitting a release-ledger record after a
                        successful \`run --components\` deploy (default: on;
                        also settable via chant.config.ts's
                        release.autoRecord: false; #597)
  --fold                (build) Fold source modules statically instead of
                        running them; folds resource constructors and
                        composite factory calls (#1022/#1023), falling back
                        to run per-file for anything else outside the fold
                        subset (a cross-file-only reference, a re-export,
                        \`export default\`, ...). Logs a fold/run count
                        (per-file lines under --verbose). DEFAULT since #1134 — this flag forces it on
                        over a chant.config.ts \`build.fold: false\`.
  --no-fold             (build) Opt out of folding for this invocation: every
                        source module is imported and run, the pre-#1134
                        behavior. Beats chant.config.ts's build.fold.
  --fold-rank [<path>]  (build, with --fold) Rank run-mode files by dominator
                        retained-count over the forward import-failure graph
                        (#1083) — fixing the top blocker unblocks the most
                        files. Files held back only by the reverse rule
                        (#1044) are reported separately, never folded into
                        the ranking. With a path argument, also writes a
                        Brendan Gregg collapsed-format export (weighted by
                        retained count) there, for any flame/icicle viewer.
  --sandbox             (build) Run run-fallback source files (or every
                        file, without --fold) together, isolated, in one
                        sandboxed child process instead of in-process
                        (#1045). No filesystem write, no child process, no
                        worker threads, no ambient environment visible to
                        project source; network egress is NOT blocked (see
                        docs). Default: off (also settable via
                        chant.config.ts's build.sandbox: true; #1045)
  --param <name=value>  (build, graph, run --components, components fan-out,
                        components promote, components rollback,
                        components redeploy) Bind a
                        declared build-time parameter (chant.config.ts's buildParams)
                        to a value, for source to read as params.<name>
                        (#1064) instead of process.env — repeatable.
                        Distinct from the AWS lexicon's deploy-time
                        Parameter(): this resolves before synthesis, so it
                        can change which resources are produced at all.
                        Highest precedence. With init --from, it sets a
                        template parameter that the template's
                        chant.template.json declares instead (#2627).
  --params-file <path>  (build, graph, run --components, components fan-out,
                        components promote, components rollback,
                        components redeploy) JSON file
                        of { "name": value } build-time parameter values
                        (#1064). Second precedence, after --param.
                        init --from refuses it: pass --param instead.

Examples:
  chant build ./infra/
  chant build ./infra/ --output stack.json
  chant build ./infra/ --format yaml
  chant build ./infra/ --watch
  chant build ./infra/ --fold
  chant build ./infra/ --components --generate gitlab
  chant build ./infra/ --components --generate gitlab --output .gitlab-ci.yml
  chant run --generate github
  chant run --components search-service --env staging
  chant run --components all --env production
  chant components export prod --component search-service -o ./dist/search-service
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
  const groupsHelp = formatCommandGroupsHelp(groups);
  if (groupsHelp) console.log(groupsHelp);
}

/**
 * Best-effort load the current project's lexicon plugins for a purely
 * read-only lookup (help composition, plugin-command dispatch) — never
 * throws, empty on any failure (no config, no lexicons, not a chant
 * project at all). Mirrors the existing best-effort loading already used
 * for `emulator`/`components status` in {@link main} below.
 */
async function loadPluginsBestEffort(): Promise<LexiconPlugin[]> {
  try {
    const lexiconNames = await resolveProjectLexicons(resolve("."));
    return await loadPlugins(lexiconNames);
  } catch {
    return [];
  }
}

/**
 * chant #1078 — the lexicon command-group seam's dispatch-time half. Core's
 * own `parseArgs`/`resolveCommand` know nothing about a lexicon's mounted
 * verbs, so this is only ever consulted after BOTH of those have already
 * failed to make sense of the invocation: either `parseArgs` threw on a flag
 * it doesn't recognize (which is *expected* for a mounted command's own
 * vocabulary — core has none), or it parsed fine but `resolveCommand` found
 * no match in the static registry (a mounted command with no extra flags,
 * e.g. `chant kube version`). Either way, a lexicon-mounted command's group
 * name and verb are always the first two CLI tokens (mirrors the `emulator
 * <up|down|status>` compound shape from #920), so `rawArgv` — the untouched
 * `process.argv.slice(2)` — is all this needs; nothing from the partially or
 * fully parsed `ParsedArgs` is used, on purpose, since core's flag-parsing
 * failure or success is irrelevant to a namespace it doesn't own.
 *
 * Returns `undefined` when nothing claims the leading token as a command
 * group at all, so the caller falls back to its own error handling
 * unchanged — a project with no lexicon exposing `commands()` (or none of
 * its plugins matching) is completely unaffected.
 */
async function tryPluginCommand(rawArgv: string[]): Promise<number | undefined> {
  const [groupName, verbName] = rawArgv;
  if (!groupName || groupName.startsWith("-")) return undefined;

  const plugins = await loadPluginsBestEffort();

  // A group declaring a `defaultVerb` (#2125) answers its bare name, so
  // `chant acp` and `chant acp --durable-requests` both reach that verb. The
  // slicing follows: with no verb token consumed, everything after the group
  // name is the default verb's own argument list.
  const group = collectCommandGroups(plugins).find((g) => g.name === groupName);
  const useDefault =
    group?.defaultVerb !== undefined && (verbName === undefined || verbName.startsWith("-"));
  const verb = useDefault ? group?.defaultVerb : verbName;
  const rawArgs = rawArgv.slice(useDefault ? 1 : 2);
  const result = await dispatchCommandGroup(plugins, groupName, verb, rawArgs);

  if (result.kind === "no-group") return undefined;
  if (result.kind === "usage-error") {
    console.error(formatError({ message: result.message, hint: result.hint }));
    return 1;
  }
  return result.exitCode;
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

  // #1344 — a lexicon that declares the shape of its own `chant.config.ts`
  // namespace gets it validated here, once, before any command runs. The
  // config schema is `.passthrough()`, so before this an unknown key inside a
  // namespace was accepted and silently ignored: `forgejo: { runnerLabel: … }`
  // left the dialect on its defaults with nothing said. A namespace whose
  // lexicon declares no schema keeps that passthrough.
  try {
    const { config } = await loadChantConfigUpward(resolve(path));
    const problems = validateLexiconConfig(plugins, config);
    if (problems.length > 0) {
      console.error(formatError({
        message: `Invalid lexicon configuration in chant.config:\n${formatLexiconConfigProblems(problems)}`,
        hint: "Remove or correct the key. A lexicon's namespace accepts only the keys it declares.",
      }));
      process.exit(1);
    }
  } catch {
    // No config, or one that failed to load — the caller's own handling stands.
  }

  return plugins;
}

/**
 * #2700 — whether `path` is the root of a declared workspace and holds no
 * lexicon of its own: no `lexicons` in a root config, and no lexicon import in
 * the root's source, which leaves the members' directories out (#2527). A
 * generated chud repo is this shape: its lexicons are all in `delivery/`.
 * `chant serve mcp` starts there instead of refusing with "No lexicon
 * detected", and serves core with the chant members' lexicons.
 *
 * A directory with no workspace declaration costs only `findWorkspaceRoot`'s
 * existence checks, so a level-0 project reaches `loadPluginsOrExit` as before.
 */
async function isLexiconlessWorkspaceRoot(path: string): Promise<boolean> {
  const target = resolve(path);
  if (findWorkspaceRoot(target)?.dir !== target) return false;
  try {
    await resolveProjectLexicons(target);
    return false;
  } catch (error) {
    return isNoLexiconDetected(error);
  }
}

/** Whether `def` must run without evaluating the project's `chant.config.ts` (chant#2591). */
function commandRunsNoConfig(def: CommandDef, args: ParsedArgs): boolean {
  return typeof def.runsNoConfig === "function" ? def.runsNoConfig(args) : def.runsNoConfig === true;
}

/**
 * Run one level-0 command line in this process and return its exit code
 * (#2537). `chant workspace member-run` calls it once per member, from inside
 * the member's directory, so each member is built, linted, audited or graphed
 * as `chant <verb> .` would do it there, while members that share a toolchain
 * share one process. It is main()'s dispatch without the help, the root
 * refusal and the lexicon command groups: the config is loaded, `--env` is
 * checked, plugins are loaded when the command needs them, and the handler
 * runs. A `process.exit` inside (loadPluginsOrExit's, say) is the caller's to
 * catch.
 */
export async function runCommandInProcess(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const match = resolveCommand(args, commandRegistry);
  if (!match) {
    console.error(formatError({ message: `Unknown command: ${args.command}` }));
    return 1;
  }
  if (args.env) process.env[ENV_VAR] = args.env;
  let loadedConfig;
  try {
    // chant#2618 — `workspace audit` reaches `audit` through here, once per
    // member. A `runsNoConfig` command skips the load, as it does in main().
    if (!commandRunsNoConfig(match.def, args)) loadedConfig = await loadChantConfigUpward(resolve(args.path));
  } catch {
    // A project with no config is the handler's to report, as in main().
  }
  const envErr = unknownEnvError(args.env, loadedConfig?.config.environments);
  if (envErr) {
    console.error(formatError({ message: envErr, hint: "Declare it in chant.config `environments`, or omit --env." }));
    return 1;
  }
  const plugins = match.def.requiresPlugins ? await loadPluginsOrExit(match.compound ? "." : args.path) : [];
  return match.def.handler({ args, plugins, serializers: plugins.map((p) => p.serializer) });
}

// ── Command registry ──────────────────────────────────────────────

/**
 * Every command word `chant` answers to, and the handler behind it.
 *
 * Exported because a caller other than `main()` now needs to ask "is this a
 * chant verb, and what runs it?" — the fountain lexicon's ACP server (#2125)
 * treats a prompt as a chant command line, and the only honest answer to
 * whether `chant lifecycle diff` is a verb is this list. A hand-kept copy
 * would be wrong the first time a command is added, and the ACP server would
 * refuse a verb that works at the terminal.
 */
export const commandRegistry: CommandDef[] = [
  // Primary commands
  { name: "build", requiresPlugins: true, handler: runBuild },
  { name: "lint", handler: runLint },
  { name: "list", handler: runList },
  { name: "describe", handler: runDescribe },
  { name: "explain", handler: runExplain },
  { name: "search", handler: runSearch },
  // chant#2591 — `import --agents` and `audit` read chant.config statically
  // and never evaluate it (chant#2589 for audit, which audits code it must not run).
  { name: "import", handler: runImport, runsNoConfig: (args) => args.agents === true },
  { name: "audit", handler: runAudit, runsNoConfig: true },
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
  // Status read over a tree of carve manifests (#2038): the contract a
  // renderer replaces its own walk-and-guess discovery with. Read-only.
  { name: "carve status", handler: runCarveStatus },
  { name: "init", handler: runInit, runsNoConfig: true },
  { name: "init lexicon", handler: runInitLexicon },
{ name: "update", handler: runUpdate },
  { name: "doctor", handler: runDoctor },

  // Dev subcommands
  { name: "dev generate", requiresPlugins: true, handler: runDevGenerate },
  { name: "dev publish", requiresPlugins: true, handler: runDevPublish },
  { name: "dev onboard", handler: runDevOnboard, runsNoConfig: true },
  { name: "dev check-lexicon", handler: runDevCheckLexicon },
  { name: "dev surface-diff", handler: runDevSurfaceDiff },
  { name: "dev pinned-upgrade", handler: runDevPinnedUpgrade },
  { name: "dev rolling-upgrade", handler: runDevRollingUpgrade },

  // Op / run subcommands
  { name: "run list", handler: runOpList },
  { name: "run status", handler: runOpStatus },
  { name: "run approve", handler: runOpApprove },
  { name: "run signal", handler: runOpSignalRenamed },
  { name: "run cancel", handler: runOpCancel },
  { name: "run log", handler: runOpLog },
  { name: "run", handler: runOp },

  { name: "operator status", handler: runOperatorStatus },
  { name: "operator log", handler: runOperatorLog },
  { name: "operator", handler: runOperator },
  { name: "approve", handler: runApprove },

  { name: "graph", handler: runGraph },
  { name: "vendor", handler: runVendor },

  // Workspace reads (#2524). Imported on first use, so a level-0 command never
  // loads anything under workspace/ (#2525 rule 5, pinned by #2526's goldens).
  { name: "workspace records", handler: async (ctx) => (await import("../workspace/records-cli")).runWorkspaceRecords(ctx) },
  { name: "workspace init", handler: async (ctx) => (await import("../workspace/init")).runWorkspaceInit(ctx) },
  { name: "workspace ls", handler: async (ctx) => (await import("../workspace/ls")).runWorkspaceLs(ctx) },
  { name: "workspace status", handler: async (ctx) => (await import("../workspace/status")).runWorkspaceStatus(ctx) },
  { name: "workspace lineage", handler: async (ctx) => (await import("../workspace/lineage-cli")).runWorkspaceLineage(ctx) },
  { name: "workspace upgrade", handler: async (ctx) => (await import("../workspace/lineage-upgrade-cli")).runWorkspaceUpgrade(ctx) },
  // #2641 — workspace check reads member configs statically and never runs one.
  { name: "workspace check", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/lineage-check")).runWorkspaceCheck(ctx) },
  // #2537 — per-member commands. Each member runs under its own chant, one
  // process per toolchain identity; `member-run` is that process's entry.
  { name: "workspace build", handler: async (ctx) => (await import("../workspace/member-commands")).runWorkspaceMembers(ctx, "build") },
  { name: "workspace lint", handler: async (ctx) => (await import("../workspace/member-commands")).runWorkspaceMembers(ctx, "lint") },
  // chant#2618 — audit runs no project code, at the workspace level too.
  { name: "workspace audit", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/member-commands")).runWorkspaceMembers(ctx, "audit") },
  { name: "workspace graph", handler: async (ctx) => (await import("../workspace/member-commands")).runWorkspaceMembers(ctx, "graph") },
  // Each unit decides for itself whether its config is loaded (runCommandInProcess).
  { name: "workspace member-run", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/member-run")).runWorkspaceMemberRun(ctx, runCommandInProcess) },
  { name: "workspace verify", handler: async (ctx) => (await import("../workspace/trust/verify-cli")).runWorkspaceVerify(ctx) },

  // State subcommands
  { name: "lifecycle snapshot", requiresPlugins: true, handler: runLifecycleSnapshot },
  { name: "lifecycle show", handler: runLifecycleShow },
  { name: "lifecycle diff", requiresPlugins: true, handler: runLifecycleDiff },
  { name: "lifecycle rollback", handler: runLifecycleRollback },
  { name: "lifecycle plan", requiresPlugins: true, handler: runLifecyclePlan },
  { name: "lifecycle affected", requiresPlugins: true, handler: runLifecycleAffected },
  { name: "lifecycle whoami", requiresPlugins: true, handler: runLifecycleWhoami },
  { name: "lifecycle teardown", requiresPlugins: true, handler: runLifecycleTeardown },
  { name: "lifecycle log", handler: runLifecycleLog },

  // Plan scenarios (#1292) — fully offline, no plugin network calls, but
  // requiresPlugins:true so the build step has serializers to partition
  // against, same as every other build-then-something verb.
  { name: "scenario check", requiresPlugins: true, handler: runScenarioCheck },

  // Component release ledger + status surface (#568, epic #551)
  { name: "components fan-out", requiresPlugins: true, handler: runComponentsFanOut },
  { name: "components status", requiresPlugins: true, handler: runComponentsStatus },
  { name: "components release", handler: runComponentsReleaseRecord },
  { name: "components export", handler: runComponentsExport },
  { name: "components promote", handler: runComponentsPromote },
  { name: "components rollback", handler: runComponentsRollback },
  { name: "components redeploy", handler: runComponentsRedeploy },

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
  { name: "scenario", handler: runScenarioUnknown },
  { name: "dev", handler: runDevUnknown },
  { name: "serve", handler: runServeUnknown },
  { name: "components", handler: runComponentsUnknown },
  { name: "workspace", handler: async (ctx) => (await import("../workspace/records-cli")).runWorkspaceUnknown(ctx) },
];

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);

  let args: ParsedArgs;
  try {
    args = parseArgs(rawArgv);
  } catch (err) {
    // chant #1078 — core's parser has no idea what flags a lexicon's own
    // mounted verb accepts, so an "unknown flag" here is expected, not a
    // real error, until we've checked whether this invocation actually
    // targets a command group. `tryPluginCommand` returns `undefined` when
    // nothing claims the leading token, in which case this was a genuine
    // core-flag error and the original is rethrown unchanged.
    const code = await tryPluginCommand(rawArgv);
    if (code !== undefined) {
      await flushAndExit(code);
      return;
    }
    throw err;
  }

  // #2701 — `chant --version` / `-V` prints the installed chant's version, the
  // one the MCP server reports (./version.ts). With a command word it answers
  // only for one of core's own commands; a lexicon-mounted verb keeps the flag.
  if (args.version && (!args.command || resolveCommand(args, commandRegistry))) {
    console.log(CHANT_VERSION);
    await flushAndExit(0);
    return;
  }

  if (args.help || !args.command) {
    const groups = await loadPluginsBestEffort().then(collectCommandGroups).catch(() => []);
    printHelp(groups);
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
  //
  // chant#2591 — a command marked `runsNoConfig` skips this load: it must not
  // run the project's `chant.config.ts` (see `CommandDef.runsNoConfig`). Such a
  // command gets no `--env` check against the declared environments either.
  const earlyMatch = resolveCommand(args, commandRegistry);
  const runsNoConfig = earlyMatch != null && commandRunsNoConfig(earlyMatch.def, args);
  const projectPath0 = resolve(args.path === "." ? "." : args.path);
  let loadedConfig;
  try {
    if (!runsNoConfig) loadedConfig = await loadChantConfigUpward(projectPath0);
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

  const match = earlyMatch;
  if (!match) {
    // chant #1078 — not one of core's own commands; check whether a lexicon
    // mounted a command group under this name before giving up. This is the
    // "parsed fine, matched nothing" trigger for the seam — the flag-error
    // trigger is above, in the `parseArgs` catch block.
    const code = await tryPluginCommand(rawArgv);
    if (code !== undefined) {
      await flushAndExit(code);
      return;
    }
    console.error(formatError({
      message: `Unknown command: ${args.command}`,
      hint: 'Run "chant --help" to see available commands',
    }));
    process.exit(1);
  }

  // #2537 (#2524 D0) — at the root of a declared workspace, `build` and
  // `lint` refuse with WSP000 unless `--root-only` or `rootOnly: true` says
  // to run on the root project alone. Both lookups only test whether files
  // exist; the workspace code loads only when this project is a declared root.
  if (match.def.name === "build" || match.def.name === "lint") {
    const target = resolve(args.path);
    const workspace = findWorkspaceRoot(target);
    if (workspace && findProjectRoot(target) === workspace.dir) {
      const { guardRootCommand } = await import("../workspace/root-refusal");
      const refused = guardRootCommand({
        verb: match.def.name,
        target,
        workspaceDir: workspace.dir,
        rootOnly: args.rootOnly === true || loadedConfig?.config.rootOnly === true,
      });
      if (refused !== undefined) {
        await flushAndExit(refused);
        return;
      }
    }
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
  // `components fan-out` (#2420) needs serializers only when it derives the
  // change signal itself (`--base` builds both refs). Reading one somebody
  // else already produced (`--from-affected`) touches no lexicon at all, so a
  // components-only project is not turned away for a step it will not run.
  const isFanOutFromFile = match.def.name === "components fan-out" && !args.base;
  // `emulator` (#920) is a property of the *configured* lexicons, not of any infra
  // file — a fresh/local project with no declarables still boots Floci. Load from
  // chant.config best-effort, like components status, rather than detectLexicon.
  const isEmulator = match.def.name === "emulator" || match.def.name.startsWith("emulator ");
  const plugins = match.def.requiresPlugins
    ? isGenerateComponents || isComponentsStatus || isEmulator || isFanOutFromFile
      ? await loadPlugins(await resolveProjectLexicons(resolve(projectPath)).catch(() => [])).catch(() => [])
      : match.def.name === "serve mcp" && (await isLexiconlessWorkspaceRoot(projectPath))
        ? [] // #2700 — runServeMcp loads the chant members' lexicons itself.
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
