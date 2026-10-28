#!/usr/bin/env tsx

import { withProductWords, type CiProductWords, type CiProductWordsInput } from "../ci-product-words";
import { resolve } from "node:path";
import { isEntryPoint } from "./is-entry-point";
import { formatSuccess, formatError } from "./format";
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
import { installCompiledCli } from "../ts-loader";
import { dispatchCommandGroup, collectCommandGroups, formatCommandGroupsHelp, type CommandGroup } from "./command-group";
import type { LexiconPlugin } from "../lexicon";
import { parseArgs } from "./parse-args";
import { flushAndExit, waitForStreamDrain } from "./flush";

export { parseArgs, waitForStreamDrain };

/**
 * #3878 — each command's handler module loads when that command runs, not on
 * every start: together they pull in most of chant (the TypeScript compiler
 * among it), and `chant --version` or `chant run wave` need almost none of it.
 */
type Handler = CommandDef["handler"];
const handlerModules = new Map<Handler, () => Promise<unknown>>();
function lazyHandler<M>(load: () => Promise<M>, pick: (module: M) => Handler): Handler {
  const handler: Handler = async (ctx) => pick(await load())(ctx);
  handlerModules.set(handler, load);
  return handler;
}
const buildHandlers = () => import("./handlers/build");
const runBuild = lazyHandler(buildHandlers, (m) => m.runBuild);
const lintHandlers = () => import("./handlers/lint");
const runLint = lazyHandler(lintHandlers, (m) => m.runLint);
const devHandlers = () => import("./handlers/dev");
const runDevGenerate = lazyHandler(devHandlers, (m) => m.runDevGenerate);
const runDevPublish = lazyHandler(devHandlers, (m) => m.runDevPublish);
const runDevOnboard = lazyHandler(devHandlers, (m) => m.runDevOnboard);
const runDevCheckLexicon = lazyHandler(devHandlers, (m) => m.runDevCheckLexicon);
const runDevSurfaceDiff = lazyHandler(devHandlers, (m) => m.runDevSurfaceDiff);
const runDevPinnedUpgrade = lazyHandler(devHandlers, (m) => m.runDevPinnedUpgrade);
const runDevRollingUpgrade = lazyHandler(devHandlers, (m) => m.runDevRollingUpgrade);
const runDevUnknown = lazyHandler(devHandlers, (m) => m.runDevUnknown);
const serveHandlers = () => import("./handlers/serve");
const runServeLsp = lazyHandler(serveHandlers, (m) => m.runServeLsp);
const runServeMcp = lazyHandler(serveHandlers, (m) => m.runServeMcp);
const runServeUnknown = lazyHandler(serveHandlers, (m) => m.runServeUnknown);
const initHandlers = () => import("./handlers/init");
const runInit = lazyHandler(initHandlers, (m) => m.runInit);
const runInitLexicon = lazyHandler(initHandlers, (m) => m.runInitLexicon);
const miscHandlers = () => import("./handlers/misc");
const runList = lazyHandler(miscHandlers, (m) => m.runList);
const runDescribe = lazyHandler(miscHandlers, (m) => m.runDescribe);
const runImport = lazyHandler(miscHandlers, (m) => m.runImport);
const runAudit = lazyHandler(miscHandlers, (m) => m.runAudit);
const runUpdate = lazyHandler(miscHandlers, (m) => m.runUpdate);
const runDoctor = lazyHandler(miscHandlers, (m) => m.runDoctor);
const vendorHandlers = () => import("./handlers/vendor");
const runVendor = lazyHandler(vendorHandlers, (m) => m.runVendor);
const migrateHandlers = () => import("./handlers/migrate");
const runMigrate = lazyHandler(migrateHandlers, (m) => m.runMigrate);
const carveHandlers = () => import("./handlers/carve");
const runCarveAdvise = lazyHandler(carveHandlers, (m) => m.runCarveAdvise);
const runCarveUnknown = lazyHandler(carveHandlers, (m) => m.runCarveUnknown);
const carveEmitHandlers = () => import("./handlers/carve-emit");
const runCarveEmit = lazyHandler(carveEmitHandlers, (m) => m.runCarveEmit);
const carveBridgeHandlers = () => import("./handlers/carve-bridge");
const runCarveBridge = lazyHandler(carveBridgeHandlers, (m) => m.runCarveBridge);
const carveApplyHandlers = () => import("./handlers/carve-apply");
const runCarveApply = lazyHandler(carveApplyHandlers, (m) => m.runCarveApply);
const carveStatusHandlers = () => import("./handlers/carve-status");
const runCarveStatus = lazyHandler(carveStatusHandlers, (m) => m.runCarveStatus);
const lifecycleHandlers = () => import("./handlers/lifecycle");
const runLifecycleSnapshot = lazyHandler(lifecycleHandlers, (m) => m.runLifecycleSnapshot);
const runLifecycleShow = lazyHandler(lifecycleHandlers, (m) => m.runLifecycleShow);
const runLifecycleDiff = lazyHandler(lifecycleHandlers, (m) => m.runLifecycleDiff);
const runLifecycleRollback = lazyHandler(lifecycleHandlers, (m) => m.runLifecycleRollback);
const runLifecyclePlan = lazyHandler(lifecycleHandlers, (m) => m.runLifecyclePlan);
const runLifecycleAffected = lazyHandler(lifecycleHandlers, (m) => m.runLifecycleAffected);
const runLifecycleLog = lazyHandler(lifecycleHandlers, (m) => m.runLifecycleLog);
const runLifecycleTeardown = lazyHandler(lifecycleHandlers, (m) => m.runLifecycleTeardown);
const runLifecycleWhoami = lazyHandler(lifecycleHandlers, (m) => m.runLifecycleWhoami);
const runLifecycleUnknown = lazyHandler(lifecycleHandlers, (m) => m.runLifecycleUnknown);
const componentsHandlers = () => import("./handlers/components");
const runComponentsStatus = lazyHandler(componentsHandlers, (m) => m.runComponentsStatus);
const runComponentsReleaseRecord = lazyHandler(componentsHandlers, (m) => m.runComponentsReleaseRecord);
const runComponentsExport = lazyHandler(componentsHandlers, (m) => m.runComponentsExport);
const runComponentsUnknown = lazyHandler(componentsHandlers, (m) => m.runComponentsUnknown);
const fanOutHandlers = () => import("./handlers/fan-out");
const runComponentsFanOut = lazyHandler(fanOutHandlers, (m) => m.runComponentsFanOut);
const promoteHandlers = () => import("./handlers/promote");
const runComponentsPromote = lazyHandler(promoteHandlers, (m) => m.runComponentsPromote);
const runComponentsRollback = lazyHandler(promoteHandlers, (m) => m.runComponentsRollback);
const runComponentsRedeploy = lazyHandler(promoteHandlers, (m) => m.runComponentsRedeploy);
const scenarioHandlers = () => import("./handlers/scenario");
const runScenarioCheck = lazyHandler(scenarioHandlers, (m) => m.runScenarioCheck);
const runScenarioUnknown = lazyHandler(scenarioHandlers, (m) => m.runScenarioUnknown);
const graphHandlers = () => import("./handlers/graph");
const runGraph = lazyHandler(graphHandlers, (m) => m.runGraph);
const explainHandlers = () => import("./handlers/explain");
const runExplain = lazyHandler(explainHandlers, (m) => m.runExplain);
const searchHandlers = () => import("./handlers/search");
const runSearch = lazyHandler(searchHandlers, (m) => m.runSearch);
const runHandlers = () => import("./handlers/run");
const runOp = lazyHandler(runHandlers, (m) => m.runOp);
const runOpList = lazyHandler(runHandlers, (m) => m.runOpList);
const runOpStatus = lazyHandler(runHandlers, (m) => m.runOpStatus);
const runOpApprove = lazyHandler(runHandlers, (m) => m.runOpApprove);
const runOpSignalRenamed = lazyHandler(runHandlers, (m) => m.runOpSignalRenamed);
const runOpCancel = lazyHandler(runHandlers, (m) => m.runOpCancel);
const runOpLog = lazyHandler(runHandlers, (m) => m.runOpLog);
const runOpEvents = lazyHandler(runHandlers, (m) => m.runOpEvents);
const runWaveHandlers = () => import("./handlers/run-wave");
const runOpWaveCommand = lazyHandler(runWaveHandlers, (m) => m.runOpWaveCommand);
const operatorHandlers = () => import("./handlers/operator");
const runOperator = lazyHandler(operatorHandlers, (m) => m.runOperator);
const runOperatorStatus = lazyHandler(operatorHandlers, (m) => m.runOperatorStatus);
const runOperatorLog = lazyHandler(operatorHandlers, (m) => m.runOperatorLog);
const runApprove = lazyHandler(operatorHandlers, (m) => m.runApprove);
const emulatorHandlers = () => import("./handlers/emulator");
const runEmulator = lazyHandler(emulatorHandlers, (m) => m.runEmulator);

/** The lexicon plugin loader, which imports the lint, fold and build machinery: loaded when a command needs plugins (#3878). */
const loadPlugins: typeof import("./plugins").loadPlugins = async (...a) => (await import("./plugins")).loadPlugins(...a);
const resolveProjectLexicons: typeof import("./plugins").resolveProjectLexicons = async (...a) =>
  (await import("./plugins")).resolveProjectLexicons(...a);

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
  search "<query>"      Answer an estate question with a few matching rows
                        instead of a graph dump (kind:, tag:, attr:, ->/<- edge
                        terms, ->* / ->{1,3} for depth, ->[via=attr] / [to=attr]
                        by attribute; --live or --snapshot <ref> (also --at
                        <ref>) with --env <name> reads the estate or a
                        recorded snapshot; --index <scope key>[@<version>]
                        answers from an index version, joined to the
                        declared rows, or alone with no project; --show <attr>,
                        --count-by kind|module|attr:<name>, --explain prints
                        paths, --json, --check-live,
                        --check-snapshot, --fail-on-drift; cap:<name> and
                        ->[cap=<name>] ask with a capability, and
                        --capabilities prints the catalog)
  query "<sql>" [dir]   Run one read-only SQL statement over chant/lifecycle:
                        the resources and snapshots each lexicon observed, Op
                        runs, gates, deploys, releases and cuts, loaded into
                        node:sqlite (schema v1, listed in chant_schema).
                        --member <name> keeps members; --json prints rows.
                        For a read contract, use chant ledger
  ledger <table> [dir]  One ledger's rows from chant/lifecycle as a read
                        contract (resources, snapshots, runs, gates, deploys,
                        releases, cuts; the columns chant query loads).
                        --where <field><op><value> (= != < <= > >= ~,
                        repeatable), --since <time|7d>, --at <rev> of
                        chant/lifecycle, --member <name>, --json
  index <substrate>     Read one aws account, azure subscription, gcp project
                        or kubernetes cluster through its inventory API, type
                        it, derive its edges and write one index version to
                        the index store. Read-only: refuses action flags.
                        --account|--subscription|--project|--cluster, --regions,
                        --types, --tag k=v, --endpoint, --store <spec>, --json
                        (chant index --help for the rest)
  index diff <a> [<b>]  What changed between two index versions of one scope:
                        <scopeKey>/<version>, or <scopeKey> for its last two.
                        --store <spec>, --json (chant index diff --help)
  generate             Generate typed code from sources chant.config declares
                        (k8s.crds, helm.charts) into src/generated/<lexicon>/
                        (codegen.outDir); --check exits 1 when the committed
                        output no longer matches its sources, as build does
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
  carve advise          Read-only advisor: ranks which resources move
                        --from <dir>      cleanly to a native lexicon
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

CI:
  ci check --base <rev> [<target>...] [--output <dir>] [--json]
                        Run the ci.hooks.check hooks the workspace declaration
                        at --base names, once each, or once per target with
                        perRun, with no forge token or cloud credentials in
                        their environment. Writes check-hooks.json under
                        --output (default .chant/check); exits 1 when one failed.
  ci check-job          The apply-job guard: compare the forge environment,
                        ref and runner the forge gives this job with the
                        expectation in CHANT_JOB_GUARD, which a generated
                        op-wave job carries. Exits 1, one line per value
                        that differs, before any credential is taken.
  ci forge-check [--env <env>] [--member <name>] [--forge <forge>] [--repo <owner/name>] [--branch <default>] [--require-clouds] [--json]
                        Read the forge, each cloud's trust policy and Pulumi
                        Cloud's OIDC policies against the pipelines
                        ci.identity.cloud gives --env (default production):
                        apply environments, branch protection, required
                        statuses, and each identity trusted to its own jobs.
                        Read-only; exits 1 on a mismatch, and with
                        --require-clouds on a cloud it had no credentials for.
  ci last-green [--json] [--from <rev>]  The newest first-parent commit of
                        ci.green's branch, or of --from, with a ci/green tag
                        and no ci/revoked tag. Reads local tags only; fetch
                        them first. With ci.green.signedSince, a tag without a
                        valid runner statement is ignored and reported.
  ci list [--json] [--limit <n>] [--since <rev>] [--forge github] [--source checks|runs]
                        The first-parent commits of ci.green's branch within
                        its window, newest first, each green, revoked or
                        undecided with its required phases' results. Reads
                        local tags; --forge reads check runs for undecided
                        commits, and source runs reads the Op runs on the
                        local chant/lifecycle, signed or not. --since replaces the window.
  ci tick [--dry-run] [--forge github] [--source checks|runs] [--key <runner key.pem>]
                        Tag each commit within ci.green's window whose
                        required phases all passed ci/green/<sha>, and revoke
                        a green one that now fails ci/revoked/<sha>. Reads
                        check runs from the forge, or with source runs
                        (ci.green.source or --source) the Op runs on
                        chant/lifecycle; with ci.green.signedSince, the ones a
                        runner key signed. Pushes the
                        tags. --key, or the PEM in CHANT_RUNNER_KEY, signs
                        each tag with a runner key. A cancelled run leaves a
                        commit unbuilt, not red, and a failed run is run
                        again once. A phase with build: newest leaves the
                        commits a newer run superseded unbuilt, and a red
                        one starts a bisect: a ci/build/<sha> tag the tick
                        starts the phase's workflow at. Each commit judged
                        gets a _ci/<sha>.json record on chant/lifecycle.
  ci run plan|apply --env <env> --base <sha> [--pr <n>] [--commit <sha>]
              [--forge github|gitlab|forgejo] [--gate <name>] [--wave-gate <name>]
              [--branch <name>] [--events-json] [--report-url <url>] [--image <image>]
              [--before-script <line>]... [--pr-build]
              [--pr-build-command <line>] [--chant <command>]
              [--pass-env <NAME>]... [--secrets <file>] [--key <runner key.pem>]
              [-o <dir>] [--wave <k>] [--require-review]
              [--no-status] [--status-url <url template>]
              [--in-place | --local] [--no-push] [--require-runner-start] [--verbose]
                        Run the pull-request pipeline's plan, record or apply job as
                        a pipeline Op in a fresh worktree of --commit (default
                        HEAD) with a clean environment. --base and --pr stand
                        in for the forge's event values. --pr-build runs
                        the job's build and lint lines first. Records the run as
                        pr-plan, pr-record or pr-apply on chant/lifecycle, which ci tick
                        from runs counts, signed when --key or CHANT_RUNNER_KEY
                        gives a runner key, and copies the report to -o
                        (default .chant/pr). --in-place runs in this checkout
                        at HEAD, as a generated forge job does, and names the
                        forge's run in the record; --no-push keeps the record
                        local. Exits with the command's code. With a forge
                        token it sets a chant/pr-plan or chant/pr-apply commit
                        status (pending, then success or failure); --no-status
                        turns that off, and --status-url links it.
                        --secrets (or CHANT_CI_SECRETS) names a dotenv or
                        JSON file only its owner can read whose values the
                        job gets, and which are shown as *** in the events,
                        the record, the report and the output.
                        With --report-url it also adds the run to
                        <url>/runs/index.json, newest first, cut to the
                        newest --run-index-limit entries (default 200).
                        Without --report-url, the workspace's ci.reportUrl.
                        --local runs the job on this machine: the record is
                        kept on the local chant/lifecycle with runOrigin
                        local and is never pushed, no status is set, nothing
                        goes under a report URL, and ci tick does not count it.
                        --require-runner-start refuses the job before its
                        first step unless a runner-start statement, signed by
                        a runner key .chant/trust.json at --base lists, names
                        this forge job.
  ci runner-start sign --key <runner key.pem> --principal <name> --job <json|@file> [-o <file>]
                        For the provisioner that starts a runner for one job:
                        sign the job's system, repo, run, attempt, job,
                        commit and runner name, and print the envelope.
  ci runner-start verify [--base <rev>] [--commit <sha>] [--json]
                        In the job: check the statement in CHANT_RUNNER_START,
                        or the file CHANT_RUNNER_START_FILE names (default
                        /run/chant/runner-start.json), against the forge's
                        variables and .chant/trust.json at --base (default
                        origin/HEAD). Exits 1 unless it verifies.
  ci run --at <sha>     Ask for every required phase at a commit of the
                        green branch with a ci/build/<sha> tag, and start the
                        workflows holding them there on GitHub when a token
                        is set; otherwise the next tick, or ci serve
                        --build-command, does.
  ci runs [--report-url <url>] [--json]
                        List the runs in the index at the report URL (default
                        the workspace's ci.reportUrl), newest first.
  ci serve --forge forgejo|github --repo <owner/repo> --env <env>
              [--interval <s>] [--max-jobs <n>] [--state <dir>]
              [--author <login>]... [--once] [--rerun-failed] [--unsigned]
              [--apply-on-merge] [--build-command <line>] [ci run's job flags]
                        Poll the forge for open pull requests and the target
                        branch's head, and run ci run plan for each new pull
                        request head and ci run record for each new commit on
                        the branch, then ci tick from the runs when the
                        workspace declares ci.green. A merge deploys nothing;
                        --apply-on-merge runs ci run apply in place of the
                        record, and --wave-gate needs it. Dedupes on job and commit in a state file
                        under --state, takes a lease per apply group, keeps
                        each apply's resume record there, and runs at most
                        --max-jobs (default 1) jobs at once. --once runs one
                        poll and waits for its jobs. --rerun-failed runs a
                        failed apply or plan again. Signs runs with a runner
                        key when .chant/trust.json at the target's head lists
                        it, and serves unsigned otherwise; with
                        ci.green.signedSince it refuses to start without one.
                        --build-command runs <line> once per ci/build/<sha>
                        tag, in a fresh worktree of the commit, with
                        CHANT_BUILD_COMMIT and CHANT_BUILD_PHASES set
  ci serve|run --setup-key [--trust [--principal <name>]] [--state <dir>] [--branch <name>]
                        Make the host's runner key (Ed25519, mode 0600) in the
                        state directory when there is none and print its public
                        key. --trust commits its runner entry on a branch of its
                        own and pushes it for review; the target branch is never
                        written
  ci init --workflow trunk-curated|trunk-curated+apply-on-merge|apply-before-merge
              [--forge github|gitlab|forgejo] [--security <group>]... [--yes]
                        Set the workspace up for a prescribed delivery workflow:
                        print what it would write as a diff, then write it on
                        --yes or a yes at the prompt and run the generators. A
                        rerun proposes only what workspace check still reports
  ci workflow [--workflow <name>]... [--output <file>]  Write
              [--chant <command>] [--install <command>]
              [--token-secret <NAME> | --app-id-var <VAR> --app-key-secret <NAME>]
              [--runner-key-secret <NAME>]
                        .github/workflows/chant-ci-green.yml, which runs the
                        tick when a required workflow completes and every 15m.
                        --chant replaces the npx @intentius/chant pin the tick
                        runs; --install adds a step before it. --token-secret,
                        or a GitHub App's id and key, pushes the tags with a
                        token that may tag commits changing workflow files.
                        --runner-key-secret hands the tick the runner key it
                        signs its tags with. For each phase that sets build,
                        it also writes the triggers and concurrency of the
                        workflows holding it: newest builds on pushes and by
                        hand, one run at a time, and every gives each commit
                        a run of its own.

Releases:
  release cut [<label>] [--at <sha>] [--yes] [--build <command>] [--param <k=v>]
              [--params-file <file>] [--src <dir>] [-o <file>] [--lexicon <name>]
              [--actor <name>] [--sign [<key file>]] [--channel <tag>] [--json]
                        A dry run of a cut of this member from HEAD, which
                        must be clean, on trunk and pushed, and carry a
                        ci/green tag: compile every environment in the
                        config's environments and print what the cut would
                        build, record and tag, and what publishes where.
                        --yes cuts: builds the artifacts once, stores the
                        release on chant/lifecycle under its digest, records
                        the actor and run id, tags the commit release/<label>
                        here, and prints the next command.
                        --build runs before each environment's templates are
                        read, with CHANT_ENV set; {env} in --params-file is
                        replaced by the environment. --sign signs the cut with
                        the actor's ssh key; an identity.gates release entry
                        requires it. A project with no components releases
                        what chant build --env <env> writes: --src <dir> is
                        the build root, -o <file> the output (dist/build.yaml),
                        --lexicon narrows it. --at <sha> cuts that commit of
                        trunk from a temporary worktree instead of HEAD, so
                        the checkout need not be clean. The label reaches
                        every compile and build as CHANT_RELEASE_LABEL.
                        A green commit of a pushed chant/compose/<name>
                        branch is cut too, recording its base and sources.
                        --channel <tag> records the tag a publish moves in
                        place of latest.
  release compose <name> [--base <label|sha>] (--pr <n> | --work <id>)...
                  [--yes] [--json]
                        Cherry-pick the chosen trunk changes, in trunk order,
                        onto the base, each with a Chant-Composed-From
                        trailer, on chant/compose/<name>. Appends to a branch
                        that exists; stops on a conflict, naming the change
                        and files, and writes nothing. A dry run unless --yes,
                        which moves the branch and pushes it.
  release candidates [--env <env>] [--json]
                        The green commits of trunk a release can be cut from,
                        newest first, each with the commits, work items, pull
                        requests and flags it would ship, and what each
                        environment runs.
  release publish <label|digest> [--yes] [--allow-unsigned]
                  [--require-provenance] [--json]
                        Publish a cut release to the targets release.publish
                        in chant.config.ts declares (npm, OCI registries,
                        forge release assets), each with the release's
                        provenance and an SBOM when it has a source. A dry
                        run without --yes. Refuses a revoked release, and
                        with a target a checkout that is not the release's
                        commit. Under security verified-releases it refuses
                        one whose signature does not verify against
                        .chant/allowed_signers unless --allow-unsigned; under
                        supply-chain it warns when the run has no OIDC token
                        and refuses a target with no SBOM source.
                        --require-provenance refuses a run with no OIDC.
  release verify <label|digest> [--json]
                        Check, offline, that the release was signed by a key
                        .chant/allowed_signers lists at the release's commit.
  release workflow [--forge github|gitlab|forgejo] [--install <command>]
              [--build <command>] [--chant <command>] [--output <file>]
                        Write the publish workflow, run on a release/** tag.
                        Under supply-chain it passes --require-provenance, and
                        under verified-releases it runs release verify first
  release list [--json]  Every release of this member with its targets, its
                        cuts and the environments that run it.
  release export <label|digest> --env <env> [-o <dir>] [--json]
                        Write the files the release recorded for <env>, each
                        checked against its digest, at their recorded paths
                        under <dir> (default: here), for a deploy to read.

Change sets:
  change-set summary <file>  The grouped plan summary of a change-set
                        [--format text|json|markdown]  document: members taking
                        [--limit <chars>]  the same change grouped, every destroy,
                                          replacement, failure and hole named.
                                          markdown fits an MR/PR note of --limit
                                          characters (default 65536). Read-only.
  change-set show <digest>  The change set a pull-request or release gate
                        [--member <name>] [--json]  bound, stored on
                                          chant/lifecycle under its digest, each
                                          entry with its graph node. Read-only.

Ops:
  run <name>            Run an Op on the resolved runtime (--on; local by default)
                        [--work <id>] [--holder <name>]: the work item an Op
                        with a work lease runs under, and who holds it
                        --fail-on-drift: exit 2 when the run completes and
                        its Drift outcome is true (WatchOp failOn: "drift")
                        --no-record: a test run that records nothing on
                        chant/lifecycle and pushes nothing (local runtime)
                        --key <runner key.pem>, or the PEM in
                        CHANT_RUNNER_KEY: sign the run's record with a runner
                        key, so ci tick from runs counts it (#4044)
  run list              List all Ops with the runtime's state for each
  run status <name>     Show the runtime's state for one Op's latest run
  run approve <op> <gate>  Record a gate's resolution and wake the runtime
  run cancel <name>     Cancel the active run (requires --force)
  run log <name>        Show run history for an Op
  run events <run>      Replay a run's events kept on this host (a run id, or
                        an Op or component name for its newest run). --json
                        prints the run-event lines; --follow streams a run in
                        progress until run-settle (#4042)
  run wave --spec <file> --wave <k>  Plan, gate and apply wave k of an Op
                        waves spec (#3679): the job a generated waves
                        pipeline runs. --decide plans and decides only;
                        --share <i> applies one share of a decided wave;
                        --group <name> applies one job group's runs.
                        --record-plans (no --wave), in a pull request's
                        pipeline: plan every wave at its head and record the
                        digests a pr-review approval mode compares.
                        --approval-status (no --wave) --forge <kind>
                        --pr <n> --head <sha> --base <sha>, or --open on
                        GitLab: post <product>/approval on an open pull
                        request's head, pending while a pr-review wave its
                        gate will hold has no approving review (#4630).
                        --waves-outcome (no --wave), after the last wave:
                        print how the wave jobs' outcome files add up
                        (applied, partial, unchanged, waiting, failed), the
                        outcome a control dispatch carries (#4617)
                        --events-json streams the job's run events (#4555);
                        with OTEL_EXPORTER_OTLP_ENDPOINT set, the job sends
                        its trace there
  run resume [--op <name>] [--gate <name>]  Start again each CI job that
                        waits at a gate an approval now answers, through the
                        forge's API (#3683); approves nothing. --gate resumes
                        that gate's job alone (#3854). Skips an approval a
                        wave already applied under; restarts an apply that
                        stopped once its run is gone (#3858). --dry-run
                        starts nothing; with --json it says per gate whether
                        it would resume and why
  run pending --plan <digest> [--op <name>]  List the gates waiting on a
                        plan digest, newest first, with the pull request a
                        pr-<n> gate belongs to (#4607). --json prints
                        { plan, gates }
  run --generate <provider>  Write one CI pipeline file per scheduled Op for
                        github, gitlab or forgejo (#2533), from every Op that
                        declares a schedule or from --spec <file.json>.
                        Files go to the forge's own directory unless
                        --output <dir>; --format json prints them instead
  run --components <name|all|a,b,c>  Run discovered Component(s) through the
                        interpret driver on the local executor (--env <env>;
                        #585). A comma list also runs what the named
                        components depend on, in dependency order, in one
                        run, and prints that order first (#3950).
                        On success, auto-emits a release-ledger record per
                        component that published a digest (default: on;
                        --no-release-record to opt out; #597).
                        --release <label|digest>: the run is of that release,
                        cut from this checkout's commit; the records name it (#4043)
                        --progress-json: stream one NDJSON RunProgressEvent
                        per line to stdout while the run executes, for a
                        consumer to render live wave/component/phase/step
                        progress instead of tailing raw logs (additive; run
                        semantics/exit code unchanged)
                        --events-json: stream the run's events instead, one
                        run-event.schema.json line each, with the run id,
                        commit and runtime on every line (#4041). Also on
                        run <op>, components promote|rollback|redeploy,
                        fan-out, pr-plan and pr-apply
                        --adopt <adoption-file>: one component's cfn-deploy
                        step adopts the file's indexed resources into its
                        stack: an IMPORT change set without markers, then a
                        tags-only UPDATE that writes them. Each change set
                        is shown and asked about before it runs (--yes
                        approves; with no terminal and no --yes, nothing
                        runs). If the marker step stops after a good import,
                        a plain deploy of the same template writes the
                        markers (#4537)
  operator               Run scheduled ticks for discovered ConvergeOps
                        locally (#1485): acquire/renew a per-op
                        lease (git ref CAS), tick on --interval, record every
                        result as a ledger fact. --env <env> scopes to one
                        environment; --interval <dur> (default 60s) and
                        --lease-ttl <dur> (default 5m) tune cadence; --once
                        runs a single round and exits (cron/systemd-timer/
                        CronJob invokers use this instead of the daemon).
                        --steward [<name>] runs a declared steward's local
                        form instead (#2731): its scheduled Ops on their
                        crons, under the steward's own lease, and its
                        beside Ops as chant run processes of their own
                        (#2861)
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
                        so the gate is re-decided from scratch next run.
                        --sign [<key file>] seals the approval with an ssh
                        key; a gate the workspace's identity.gates names
                        counts only an approval sealed by a key the signers
                        file at base lists for --actor. --relayed-by
                        <principal> records who carried the approval to chant
                        for --actor (a follower, a bot); --sign covers it.
                        --resume then starts the CI job that waits at the
                        gate again (GitHub re-run, GitLab retry, Forgejo
                        dispatch) with CHANT_FORGE_TOKEN
                        At a terminal it shows the stored plan and asks you
                        to type the target's name (the environment, else the
                        gate) before recording; a wrong answer exits 8, a
                        plan that moved while you were asked exits 4.
                        --yes, --json, CI and no terminal record as before
                        (#4575)
                        On op policy-override the gate is the subject a
                        policy denied: --rule <id> names each rule that
                        denied it and --reason <text> says why the plan goes
                        out anyway; the next run that plans the same digest
                        applies it once, if .chant/overriders at base lists
                        --actor

  audit-log attribute --input <drift.json> [--audit-log aws[:<region>]]
                        Name who changed each drifted attribute of a drift
                        document: a known write by design, else the cloud
                        audit log's last writer (#4632)
  audit-log unrecorded --audit-log aws[:<region>] --op <op>[,...] --since <time>
                        Report the audit log's writes no recorded apply on
                        the run ledger made; exits 2 when there are some
                        (#4632)
  notify relay          Serve the relay that approves a waiting gate from a
                        Slack button or a Teams reply (#4611): verifies the
                        chat signature and the button's notify reference,
                        maps the clicker through the signers file at base,
                        and records chant approve --plan <digest> --actor
                        <principal> --relayed-by <relay>. Settings come from
                        CHANT_RELAY_KEY, SLACK_SIGNING_SECRET,
                        TEAMS_WEBHOOK_SECRET, CHANT_RELAY_PRINCIPAL,
                        CHANT_RELAY_MAX_AGE, CHANT_RELAY_HOST (default
                        127.0.0.1) and CHANT_RELAY_PORT (default 8787)

  lock <target>...      Lock targets for a pull request on chant/lifecycle
                        (--pr <n>, --stage plan|apply|lock, --head <sha>,
                        --by <who>, --gate <name>, --json). --from-report
                        <pr-plan.json> locks the components a plan selected.
                        --forge <kind> reads which holders are still open and
                        posts chant/lock on --head. Exits 3 when another open
                        pull request holds a target. --list prints the locks
  unlock [<target>...]  Release the locks a pull request holds (--pr <n>,
                        --gate <name>, --json)
  graph                 Show Op dependency graph (--stacks for cross-stack order,
                        --format ir|mermaid|dot|layout for the lint-gated graph IR,
                        a Mermaid flowchart, Graphviz DOT, or node positions;
                        layout uses dagre by default (no native dep) — pass
                        --node-sizes <json|-|@file> for size-aware spacing,
                        --layout-engine graphviz to use dot instead;
                        --detail 0..3: stacks|composites|declarables|attributes;
                        --lens lexicon:<n>|stack:<n>|blast:<node> (--up/--down))
                        --format ir --capability-view: add the lexicon-neutral
                        view capability rules read, as this project's lexicons
                        map it, to the IR as capabilityView (#4378)
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
                        --from tfc|spacelift|backstage proposes from a
                        Terraform Cloud organization (--org, or --input <export>),
                        a Spacelift account (--endpoint, or --input <export>) or
                        the catalog-info.yaml files under dir, and shows what
                        it left out (#3178)
  workspace promote <member> [--state <tfstate>] [--lexicon <name>] [--dry-run] [--output <patch>] [--json]
                        Change a member's kind (terraform to choudoufu runs
                        live-check and the adoption report; choudoufu or
                        other to chant runs chant import), staged
                        in a worktree and gated on the patch digest like upgrade
  workspace promote --all [--state-dir <dir>] [--state <member>=<tfstate>]... [--canary <member>] [--wave-size <n>] [--dry-run] [--json]
                        Adopt every terraform member into choudoufu in waves:
                        the canary first (default the first member), then
                        --wave-size roots a wave (default 5), one gate per
                        root bound to its live-import report digest. A wave
                        that does not land stops the later ones (#4461)
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
  workspace metrics [dir] [--env <env>] [--member <name>] [--since <date>] [--json]
                        The four DORA metrics per member and environment
                        (#4039): deployment frequency, lead time from commit
                        to running release, change failure rate and time to
                        restore, from the deploy records, releases and ci
                        revoked tags. Eight weeks back by default. Read only;
                        never fetches. --json prints the read-contract document
  workspace records [--kind <kind file>] [--current] [--uncommitted | --at <rev>] [--base <rev>] [--require attested] [--where <field><op><value>]... [--json]
                        Without --kind, every record kind the declaration
                        names. Read the records a record kind locates, validated
                        against its schema, with reason codes for invalid
                        ones. --current leaves out superseded records; --at
                        reads a commit's git objects. Needs no workspace file.
                        Each record reports its provenance level, judged by
                        the signers at --base (default: the target branch);
                        --require attested exits 2 if any record is not
                        attested. A pinned file that changed is a warning,
                        asset-drift or asset-missing. In the working tree,
                        each record says whether it is committed, modified
                        or new against HEAD, with the branch and base;
                        --uncommitted lists only the modified and new ones;
                        --where keeps the records a typed filter matches
                        (id, path, state, valid, data.<key>, ...)
  workspace records [--kind <kind file>] --since <rev|session id> [--at <rev>] [--json]
                        What changed in the records between <rev> and --at
                        (default: the working tree): new and removed records,
                        state transitions, new verdicts, new supersessions
                        and changed pins. A session id compares the commits
                        the session opened and closed at
  workspace records pin <path> [--kind <kind file>]
                        Print the path from the workspace root and the
                        sha256 of a file, for a decision's evidence pin. The
                        root is the kind file's workspace with --kind, else
                        the workspace above the current directory
  workspace records new [<kind file>] --from <file|-> [--prefix <prefix>] [--sign [<key file>]] [--dry-run]
                        Write one new record in the kind's directory from
                        the JSON fields given, after validating them as
                        records would read them. Without a kind file, the one
                        kind the declaration names. Allocates the next id when
                        the fields hold none. --sign seals the record's author
                        (decided_by for decisions) with an ssh key. Prints
                        {path, id} as JSON and never commits
  workspace records amend <id> [--kind <kind file>] --set <file|-> [--expect <digest>] [--sign [<key file>]] [--dry-run]
                        Set top-level fields of one record. A closed record
                        never changes, and an approved one changes only its
                        state (upward), pins and reviews; anything else is
                        refused with amend-supersede-instead. Moving a
                        record to its kind's ratified state (ratified for
                        decisions) is refused with ratify-quorum-not-met
                        until its quorum is met. --sign seals the author
                        again; without it an amendment removes the author
                        seal and says so. --expect refuses the write with
                        record-conflict when the record's digest has moved
                        on. Prints {path, id, changed, digest}
  workspace records review <id> [--kind <kind file>] --verdict agree|dissent|abstain --by <principal> [--note <text>] [--session <id>] [--expect <digest>] [--sign [<key file>]] [--dry-run]
                        Append a review to one record, dated and bound to
                        the digest of the record text. A dissent needs
                        --note. --sign seals it with an ssh key (git's
                        user.signingkey without a file); under a signers
                        file at base only a sealed verdict counts. With
                        --session, the session must be open, and the verdict
                        is appended to its verdicts too. --expect refuses a
                        verdict on a record that moved on. Prints
                        {path, id, review, digest}
  workspace records close <session id> [--kind <session kind file>] [--expect <digest>] [--dry-run]
                        Close an open review session: its state, close time,
                        closing commit and seal, in one write. Without
                        --kind, the one session kind the declaration names.
                        Prints {path, id, changed, seal, closedRev}
                        Every working-tree write holds the working tree's
                        write lock (CHANT_WRITE_LOCK_WAIT_MS, default 15s)
  workspace lock [acquire --holder <name> [--ttl <duration>] | release --token <token>] [--json]
                        Who holds the working tree's write lock; take it for
                        a batch of writes across chant calls, each run with
                        CHANT_WRITE_LOCK=<token>, and give it back
  workspace work claim|renew|release <id> --holder <name> [--kind <kind file>] [--ttl <seconds|duration>] [--token <token>] [--outcome <outcome>] [--note <text>] [--json]
                        Take, heartbeat or give back the lease on a work item:
                        refs/chant/lease/work/<id>, a compare-and-set ref with a
                        fencing token and an expiry, pushed to the remote so
                        separate clones coordinate. A claim is refused, exit 2,
                        while anyone holds it live. Each change appends to
                        _leases/<id>.jsonl on chant/lifecycle
  workspace work history <id> [--kind <kind file>] [--json]
                        A work item's lease history: each claim with its token
                        and holder, and how it ended, released with an outcome
                        or never released (expired or lost). Read-only
  workspace work evidence <id> --holder <name> --token <token> --from <file|-> [--kind <kind file>]
                        Attach evidence for one acceptance criterion under the
                        lease you hold: the entry (criterion, result, title,
                        a url or a path pinned by hash) is appended to the
                        item's pins through records amend. Prints the
                        work-evidence document and never commits
  workspace runs [--unit <id>] [--decision <id>] [--by <principal>] [--since <rev>] [--where <field><op><value>]... [--follow-squash] [--json]
                        The agent runs in the run ledger on chant/lifecycle, each
                        with its model, tokens, cost and the commits it made,
                        and totals per work item, decision and principal; a run
                        that reports no cost is listed as unpriced, never zero.
                        Read-only, never fetches; --follow-squash joins each
                        squash merge to its pull request's runs, fetching a
                        missing refs/pull/<n>/head from origin; --where keeps
                        the runs a typed filter matches (state, model,
                        startedAt, cost.amount, ...) before the totals
  workspace runs start --from <file|->
                        Record that an agent run started: who it worked for,
                        its harness, model, work item and lease. Prints the run
                        and its Chant-Run trailer. chant never starts a run
  workspace runs end <run id> [--from <file|->]
                        Record how a started run ended: its outcome, tokens,
                        cost and price source, the transcript pinned by hash,
                        and the commits it made
  workspace runs record --from <file|->
                        Record a finished run, its start and end in one write
  workspace runs sign <run id> (--key <runner.pem> | --envelope <file|->) [--base <rev>]
                        Store a DSSE statement over an ended run (its record's
                        hash, work item, harness, model and commits), signed
                        with a runner or steward key .chant/trust.json lists
                        at base, or signed elsewhere and checked here
  workspace runs statement <run id> --signer <principal>
                        Print the statement for a signer whose key is
                        elsewhere, such as a lobby, with the payload to sign
  workspace runs verify [<run id>] [--require signed] [--base <rev>] [--json]
                        Judge each run's stored statements against the runner
                        keys at base. Reports only, unless --require signed
  workspace box listing set <member> [--from <file|->] [--cover <image> [--cover-path <path>]] [--by <principal>] [--dry-run]
                        Change a box's listing (published, title, line, cover)
                        in the declaration, in place, keeping its formatting
                        and comments; --cover copies a PNG, JPEG or WebP into
                        the repository. Judged by the write scope at base.
                        Prints the box-listing-write document; never commits
  workspace member add <name> --from <file|-> [--by <principal>] [--dry-run]
  workspace member remove <name> [--by <principal>] [--dry-run]
  workspace host set <name> --from <file|-> [--by <principal>] [--dry-run]
                        Add or remove a member's entry, or add or replace a
                        host's, in the declaration, in place, keeping its
                        formatting and comments. Refuses a declaration that
                        doesn't read, or two boxes sharing a port. Judged by
                        the write scope at base. Prints the member-write
                        document; never commits
  workspace box factory set <member> --from <file|-> [--by <principal>] [--dry-run]
                        Change a box's factory (builds, check, checks,
                        builders, tiers, publish) in the declaration, in
                        place, such as where a planted box publishes. Judged
                        by the write scope at base. Prints the
                        box-factory-write document; never commits
  workspace box publish <member> (<item> | --records) [--by <principal>] [--head <owner/name>] [--dry-run]
                        Publish a built work item, or the records kept
                        uncommitted, through the publisher the box block names:
                        run with a JSON request on stdin, its answer checked
                        and its commit held to the apply record (ws-088).
                        Prints the box-publish document; chant itself never
                        commits, pushes or calls a forge
  workspace wip [--branch <branch>] [--json]
                        List the work-in-progress snapshots under
                        refs/chant/wip/<branch>, newest first, and how far each
                        ref the box's replicate policy names is from its remote.
                        Reads locally; never fetches (#3172)
  workspace wip save [--label <text>] [--by <principal>]
                        Snapshot the whole working tree, uncommitted records
                        included, onto refs/chant/wip/<branch> without touching
                        the index or the branch; pushes when the policy says so
  workspace wip restore [<snapshot>] [--by <principal>]
                        Put the working tree back as the snapshot (the branch's
                        latest by default) holds it, after a snapshot of how it
                        is now; HEAD never moves
  workspace wip push    Push the refs the box's replicate policy names to its
                        remote, never forced, for the host's schedule
  workspace wip fetch   On a replacement box, bring back what was replicated:
                        create or fast-forward the local refs, then wip restore
  workspace points [--open] [--kind <kind file>] [--at <rev>] [--json]
                        List the decision points the declared answer kinds'
                        points files declare, and the questions asked of them;
                        --open keeps the escalated and proposed ones (ws-058)
  workspace points ask <point> --inputs <file|-|json> [--candidates <file|-|json>] [--response <file>] [--subject <id>] [--store <tree|ledger>] [--kind <kind file>] [--dry-run]
                        Ask a point's table, model and quorum deciders and
                        record the answer: proposed from a model, escalated to
                        people below its threshold. --response is a POST
                        /v1/systemone response the caller got; chant calls no model.
                        --candidates gives an ad-hoc point's question and
                        candidates, { question, criteria }. --store ledger
                        holds the question on chant/lifecycle and pushes it,
                        for a checkout that does not outlive the run (CI)
  workspace points answer <id> --answer <value> --by <name>... [--note <text>] [--relayed-by <principal>] [--kind <kind file>] [--resume] [--dry-run]
                        Record people's answer to an open question, or confirm
                        a model's proposal, once the point's quorum is met,
                        with their note and who relayed it. --resume then
                        starts again the CI job waiting at the gate the
                        question names, when the answer passes it
  workspace points retract <id> --by <name>... [--note <text>] [--kind <kind file>] [--dry-run]
                        Take an answer back: the question is open for people
                        again, and the answer stays in its retractions
  workspace points withdraw <id> --by <name>... [--note <text>] [--kind <kind file>] [--dry-run]
                        Close an open question that no longer applies, such as
                        one about a work item its author changed: points --open
                        leaves it out, nobody answers it, and asking it again
                        opens it again (#2888)
  workspace pin <path> [--json]
                        Print the integrity value that pins the plugin at
                        <path>, to put in a path pin of chant.workspace.json.
                        chant checks it before it reads the plugin
  workspace agent [<name>] [--json]
                        Print an agent session from the declaration: the one
                        member it is bound to, the record kinds and verbs its
                        write scope allows, and the spec records --current
                        prints. Without a name, the session CHANT_AGENT names
  workspace verify [--base <rev>] [--head <rev>] [--require attested | attested-runs]
                        Check the commits in base..head against the signers
                        and roles read from base. A change to the signers file
                        or .chant/trust.json needs a signature by a signer
                        trusted at base, and a new signer set needs a
                        threshold of the old one. A commit an agent run made
                        is attested by the run's signed statement; with
                        attested-runs, only those commits must be
  workspace trust runner add <principal> --key <ssh-ed25519 line or file> [--class runner|service] [--by <principal>] [--expect <digest>] [--dry-run]
  workspace trust runner remove <principal> [--by <principal>] [--expect <digest>] [--dry-run]
                        List a runner's key under runners in .chant/trust.json,
                        granting a runner the runner role, or take both away,
                        editing the file in place. --expect refuses the write
                        when the file's digest has changed. Prints the
                        trust-write document and the new digest; never commits
  workspace signers [--json] [rotate [--threshold <n>] | sign --key <file>]
                        Show the signer history at base, or propose the next
                        signer set and sign it with a current signer's key
  workspace evidence sign --kind <kind file> --key <runner.pem> --check-id <id>
                        Sign runner evidence over the records' hashes in a
                        DSSE envelope, with a runner key .chant/trust.json
                        lists. For CI and services, never a person's key
  workspace evidence verify --envelope <file> [--at <rev>] [--json]
                        Verify runner evidence offline, and whether the
                        records it covers are unchanged
  workspace lineage [--json]
                        Show each scope in .chant/workspace.lock.json: its
                        template and pin, locally edited files and open
                        manual steps. Needs no workspace file
  workspace lineage resolve <path>
                        Close a manual step once the file is merged by hand
  workspace exit [<member>...] [--dry-run] [--drill] [--output <file>] [--json]
                        Leave chant: build each chant member once, commit the
                        native output (CloudFormation, ARM, Kubernetes YAML,
                        Compose, CI files), point its CI at the platform's own
                        CLI, drop the chant dependencies and set the member to
                        other. Staged in a worktree and gated on the patch
                        digest (chant approve workspace-exit <scope>). op.json
                        files stay. --drill runs it on a scratch copy and
                        checks each member, changing nothing.
  workspace upgrade [<scope>] [--to <ref|dir>] [--source <repo>[#<member>]] [--allow-code] [--dry-run] [--output <file>]
                        Bring a lineage scope to a newer template version: fetch
                        it, migrate and merge per file in a worktree, run build,
                        lint and workspace check there, then gate on the digest
                        of the patch (chant approve workspace-upgrade <scope>).
                        A second run with the approval applies the patch.
                        --source <repo>[#<member>] moves the scope to another
                        template through that template's bridge migration
  workspace adopt-lineage [<scope>] --from <repo>[@<ref>][#<member>] [--tags <glob>]
                        [--index <file>] [--param name=value] [--dry-run] [--json]
                        Give a scope a git lineage: match a scope with none
                        against the template's versions and record the best
                        one, with the adopted commit range in .chant/trust.json,
                        or move a directory lineage onto the version that
                        reproduces its recorded files
  workspace hash-index --from <repo>[#<member>] [--tags <glob>] [--output <file>]
                        Compute the per-version file hashes adopt-lineage
                        matches against, for a template's CI to publish
  workspace versions [<dir>] [--template <id>] [--available [--tags <glob>]] [--json]
                        Report the template, chant and lexicon versions of
                        every lineage lock under <dir>, grouped into families
                        by template; --available also lists each git
                        template's version tags and where each lock sits
  workspace export [<member>[,<member>...]] [--to <member>] [--param name=value] [--dry-run] [--json]
                        Write members that set travel, with their lineage and
                        records, into the export member (role export) as a
                        workspace of their own; with no member named, every
                        member that travels and the workspace's own records.
                        --param gives a host-bound parameter its value there
  workspace import [<dir>] [--remove] [--dry-run] [--json]
                        Bring an export back: merge per file against the
                        export's hashes, switch host values back, record the
                        return in .chant/returns/<id>.json with the commits the
                        files were made in, then write the export member again
                        or, with --remove, remove it
  workspace admit <return id> [--note <text>] [--dry-run] [--json]
                        Admit the signers of a return in .chant/trust.json, so
                        its signed work reads as attested once merged
  workspace check [--at <rev>] [--json] [--format stylish|json|sarif] [--generated] [--kind <kind file>] [--live --env <env>] [--forge-repos <file>]
                        Fail on an unreadable lineage lock or an open manual
                        step, and, in a declared workspace, on a WSP check of
                        the declaration, member ledgers, pipelines or
                        generated files. --generated runs declared generators
                        and compares their output. --kind warns on records
                        whose pinned files changed. Needs no workspace file.
                        --at reads a commit's git objects; --format json
                        prints the read-contract document. --live --env
                        resolves each declared member link against the live
                        graph of <env> (each chant member runs chant graph
                        --live, which reaches the account) and reports
                        WSP141 and WSP142. --forge-repos reads a forge's
                        repository list from a file and reports repos an
                        org workspace lacks (WSP014) or names that the
                        forge no longer has (WSP015)
  workspace check --changes <base>..<head> [--work <id>] [--severity off|warn|fail] [--kind <kind file>...] [--json]
                        Map each path the diff changes to the current records
                        whose constrains cover it: change-uncovered when none
                        does, change-out-of-scope when a record in hand (the
                        --work item and its decisions) lists it in
                        out_of_scope. The declaration's changes block sets
                        the severity (warn by default) and ignore globs. When
                        the declaration at base has writeScope or agents, each
                        commit that writes outside its writer's scope fails
                        the check (write-scope-member, write-scope-kind). Each
                        first-parent commit of the range should name its work
                        item in a Chant-Record: <work kind>:<id> or a
                        Chant-Lease trailer. commit-unlinked is a commit that
                        names none, commit-wrongly-linked one whose trailers
                        name no work item that exists; both follow the
                        severity
  workspace patch <base>..<head>|<base>...<head>|<commit> [--path <p>...] [--max-bytes <n>] [--json]
  workspace patch [<commit>] --worktree [--path <p>...] [--max-bytes <n>] [--json]
                        The hunks of a diff, file by file: a range, a work
                        branch, or one commit against its first parent. Each
                        file's hunk text stops at --max-bytes (64 KiB) and
                        says it was truncated
  workspace build [dir] [--member <name>] [-o <dir>] [--dry-run]
                        Build every chant member and example project, each with
                        its own chant, one process per toolchain. -o <dir>
                        writes <dir>/<member>.json; --member narrows the run;
                        --dry-run prints which chant runs which project
  workspace lint [dir] [--format stylish|json|sarif] [--member <name>] [--cross-root]
                        Lint every chant member and example project with its
                        own chant; sarif writes one run per member.
                        --cross-root adds the disagreement lint (LNK001 and
                        the lexicons' cross-root checks) over every member's
                        graph, where declared links and the graphs disagree
  workspace audit [dir] [--json] [--member <name>]
                        Audit each chant member with its own .chant-audit.json;
                        every finding carries a member field
  workspace graph [dir] [--at <rev>] [--member <name>] [--kind <kind file>] [-o <file>]
                        Compose each chant member's chant graph into one IR,
                        with <member>/<id> ids and groups.byMember: the
                        read-contract document. --at <rev> runs each member's
                        source as it was at that commit; --kind adds the
                        records' asset and constrains links. A member whose
                        source and toolchain are unchanged is served from
                        the cache in $CHANT_CACHE_DIR or ~/.cache/chant;
                        --no-cache reads every member
                        --capability-view: each member's chant adds its
                        capability view, mapped by its own lexicons
  workspace drift --member <name> [--read <state|plan|refresh|live-read|ownership>] [--resource <addr>] [--env <name>] [--stream] [-o <file>]
                        One member's drift, read by its own engine: a chant
                        member through lifecycle diff --live (needs --env), a
                        terraform member through its state or a plan, a
                        choudoufu member through live-plan (and a plan for
                        --read plan), one resource through choudoufu
                        live-plan -resource. One drift document, or with
                        --stream the NDJSON stream (drift-start, records,
                        drift-settle)
  workspace search "<query>" [--member <name>] [--env <name>] [--snapshot <ref> | --live] [--at <rev>] [--explain] [--count-by ...] [--json]
                        chant search in every chant member, each under its own
                        chant, as one read-contract document: ids are
                        <member>/<id> as workspace graph prints them, each
                        member is searched alone, and a member that can't be
                        searched has a reason code. --at <rev> is the git
                        revision; --snapshot <ref> replays a recorded snapshot
  workspace graph --composites [--at <rev>] [--member <name>] [-o <file>]
                        Each composite instance the members declare, with the
                        components whose contract can deploy it; an instance
                        with none lists an empty set
  workspace graph --intent <path[:start-end]|path#symbol|member/node|sha> [--at <rev>] [--kind <kind file>...] [--follow-squash] [--json]
                        The intent graph over one region: the commits that
                        touched it, the decisions whose constrains cover it,
                        the artifacts they pin, and findings with closed codes.
                        Without --kind, every record kind the declaration names.
                        --follow-squash follows a squash merge to its pull
                        request's commits, fetching a missing ref from origin
  workspace graph --intent --record <id> [--at <rev>] [--kind <kind file>...] [--follow-squash] [--json]
                        One decision's intent walk over every path: and member:
                        entry it constrains: the commits in its window, each
                        own, worked, within-other or unexplained, with counts
  workspace run <member>/<op>... [--env <env>] [--gate <name>] [--on <lexicon>] [--dry-run] [--json]
                        Run Ops that span members (#2554): each target's chant
                        run <op> in the member's directory, under its own
                        chant, producers before the members that link to them.
                        OPS019 checks every target against the composed graph
                        first. Member run records cite the workspace run,
                        whose record goes under _members/_workspace/<env>/.
                        Exits 3 when a step stops at a gate
  workspace run --dependents-of <member> --op <op> [--env <env>] [--gate <name>] [--dry-run] [--json]
                        Run <op> in every member that links to <member>,
                        directly or not, nearest first; members without the
                        Op are listed as skipped
  workspace run approve <gate> [--plan <digest>] [--approver <principal>]
                        Approve a workspace gate's pending fact. It stands in
                        for a member gate only when it covers that member's
                        plan and the member sets acceptWorkspaceGates at base
  workspace train <env> [--pin <member>=<label|digest>]... [--dry-run] [--json]
                        Record a release train: one cut release of every
                        chant member (the newest, unless --pin picks one),
                        under _members/_workspace/<env>/trains.jsonl. Refuses
                        when a member has no release
  workspace train list <env> [--json]
                        The release trains recorded for <env>, oldest first

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
                            --index <ref>: compare source with an index version
                            in the store, no deploy and no cloud read (#4526)
  lifecycle plan <env>      Typed change set (create/update/delete/adopt) vs live
                            --deep: also report properties declared
                            heldElsewhere(). Never changes what the plan
                            proposes; costs a provider call pair per readable
                            resource, so the read's cost becomes a function of
                            estate size rather than stack count (#2405)
  lifecycle affected        Stacks a change affects (--base <ref> [--include-dependents])
                            --json: emit the ChangeSet as JSON
  lifecycle health <env>    Whether each declared service is up, separate from
                            drift: ECS running vs desired, Route 53 health
                            checks, Container Apps revisions, Cloud Run Ready.
                            A failed read is "not read", never unhealthy (--json)
  lifecycle drift           Each lexicon's own drift read, as drift-record
                            NDJSON (--member, --read, --resource); what
                            workspace drift runs in a member's reader project
  lifecycle whoami <env>    Who chant would act as in each configured lexicon,
                            and what that principal is scoped to — read-only,
                            before anything acts (--json, --strict)
  lifecycle teardown <env>  Plan what deleting the environment would remove —
                            marker-scoped (this project's stack + env); --yes
                            executes the plan (production-like names also need
                            --confirm-prod, or an interactive confirmation)
  lifecycle log [env]       History of lifecycle snapshots
  lifecycle gc [--yes] [--push] [--json]
                            Prune stored change sets, releases and run event
                            files by the retention policy (#4036). A dry run
                            without --yes; --yes writes one commit removing
                            them on the local chant/lifecycle and deletes the
                            run event files; --push pushes it. History is
                            never rewritten, and the ledgers are never pruned

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
                             puts one approval over the whole set;
                             --wave-gate <name> puts one on each wave, planned
                             when the wave is reached, with --canary <name>
                             for wave 1 and --wave <n> for one wave per CI
                             job; --resume <file> finishes an attempt that
                             stopped; --target <component>:<address> plans
                             and applies only that address)
  components pr-plan       Plan the components a pull request reaches and
                            the ones that depend on them, and write the
                            report and note (--base <ref> --pr <n>
                            [--forge github|gitlab|forgejo] posts them);
                            --target <address> narrows every member's plan
                            to the address, --target <member>:<address>
                            one member's (#4620); --comment-targets adds the
                            --target addresses of the preview comment in
                            CHANT_PREVIEW_COMMENT (#4626); --refresh refreshes
                            each step's state first and --target-dependents
                            plans what depends on each target too, refused
                            by name for a step that cannot (#4627);
                            --parallelism <n> plans at
                            most n members of a wave at once (#4625);
                            applies nothing
  components pr-post       Post the plan note and the chant/plan status
                            from the report pr-plan --no-status wrote
                            (--pr <n> --head <sha> --env <env> --forge
                            <kind>), in a job that runs none of the
                            change's code (#4295); --open posts every
                            open merge request's from a GitLab pipeline
                            of the target branch (#4328); --respond
                            description=check --decide-backend <name>
                            --decide-model <id> asks whether the
                            description leaves out a destroy or a
                            replacement and posts the finding (#4629)
  components pr-record     On merge (#4168): plan the same members again,
                            store the change set and write the merge record
                            _merges/<commit>.json; applies and refuses
                            nothing, and a plan that differs from the
                            approved one sets a failing chant/record status
  agent prepare|run|land   The agent jobs (#4616) the Op generator writes for
                            a spec's agent: prepare decides from the comment or
                            the drift check and the ledger's run count, run
                            runs the model command with no forge token, land
                            pushes the change, opens or updates the pull
                            request and records the run (--forge <kind>)
  components pr-env        An environment per open pull request (#4298): up
                            --base <ref> --pr <n> applies the change to pr-<n>,
                            derived from ci.prEnvironment.template, once an
                            approval of its plan stands (chant approve pr-<n>
                            pr-env --plan <digest>); post --pr <n> --head
                            <sha> keeps the record up --no-push handed on and
                            posts the note; down --pr <n> tears down
                            only what carries pr-<n>'s ownership marker; sweep
                            tears down each one whose TTL passed or whose pull
                            request closed. Never a release target
  components pr-apply      With --apply-on-merge: plan the same members again and apply
                            them only if an approval stands for that digest
                            (chant approve pr-<n> pr-apply --plan <digest>);
                            a moved plan refuses with exit 3
                            (--require-review: the approver must have
                            approved the pull request on the forge;
                            --member <name>, both commands: a workspace
                            member's loop, gate op pr-<n>-<member>;
                            --resume <file> finishes an apply that failed
                            partway under the same approval;
                            --wave-gate <name>: apply a wave at a time on op
                            waves, each planned after the one before applied,
                            a moved wave waiting at <name>-wave-<k>, with
                            --wave <k> for one wave per CI job;
                            --green: apply the green commit at HEAD, measured
                            from the one last applied to --env, under the
                            approved plans of the merges since, else at gate
                            op green-<sha>;
                            --before-merge --pr <n>: apply the open pull
                            request's head under its gate, once the
                            declaration at base sets ci.workflow to
                            apply-before-merge and the forge says it is
                            approved, mergeable, undiverged and green;
                            --requires <list> asks only the checks it
                            names (approved,mergeable,undiverged,checks);
                            --merge auto --merge-token-env <VAR> merges the
                            pull request once every member applied and the
                            records are pushed, with that token alone and
                            the applied head checked again (#4636);
                            --respond <list> turns the failed apply's
                            triage and the refused apply's diff on or off
                            (wave-refused=diff|off,apply-failed=triage|off,
                            #4629);
                            --events-json, both commands: the run-event
                            stream on stdout; --report-url <s3 or file URL>,
                            both commands: copy the report, the change set
                            and the events to <url>/<pr>/<commit>/)
  components plan-wave --runs <file> --plans <file> --base <ref> --env <env>
                           Plan one op wave's components through their
                           capabilities and write the wave's plans file
                           with its change set (#4588); --wave-outputs
                           <file> seeds the outputs earlier waves left
  components apply-wave --runs <file> --plans <file> --base <ref> --env <env>
                           Plan the approved runs again, exit 4 when a plan
                           moved, else apply them and add their outputs to
                           --wave-outputs (#4588). Both are the steps of the
                           waves pr-apply --wave-gate runs on op waves
  components release <env> Append one immutable release record
                            (--component <name> --digest <sha256:...>
                             [--git-sha <sha>] [--run-id <id>] [--actor <name>]);
                            --release-plan <file> takes --digest's place,
                            persisting the release plan the file holds to
                            _plans/<digest>.json (ws-055) and recording its
                            own digest
  components export <env>  Materialize a persisted build archive manifest to
                            a portable directory (--component <name>
                            [--digest <manifestDigest>] -o <dir> [--json]);
                            copies every image/template/asset/sbom entry
                            byte-for-byte plus a self-describing manifest.json
  components promote        Deploy the digests one environment's release
                            ledger records to another, without a build
                            (--to <env> [--from <env>] [--allow-skip]
                             [--release <label|digest>]
                             [--component <name> [--digest <sha256:...>]];
                             --from defaults to the environment before --to
                             in the config's environments; --dry-run prints
                             the plan; the target's gates still apply. Under
                             --release a dependent plans against its
                             upstream's planned outputs and plans again once
                             it applies; --wave-gate <gate> checks each wave
                             at <gate>-wave-<k>; a stop writes --resume <file>)
  components rollback <env> Redeploy an earlier release of an environment
                            from its recorded digest (--component <name>
                            [--digest <sha256:...>]; defaults to the release
                            before the current one; --dry-run prints the plan).
                            --release <label|digest> restores every component
                            of that release through the release gate (#4035)
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
  dev pinned-upgrade <dir> [pin]
                           Report if a lexicon that declares upstreamPin (k8s, k3s, gcp, docker,
                           gitlab, cedar, sql) has a newer upstream release; dry-run bump + regen +
                           surface-diff, then revert. A pin that moves with other constants (sql's
                           image digest) is reported with how to move it, not edited. A lexicon
                           with several pins (sql: clickhouse, postgres-14 .. postgres-18) gets one
                           report per pin; name a pin to check only that one
                           (reports only; --force bypasses the spec cache, -f json for JSON)
  dev rolling-upgrade <dir>  Report rolling-spec drift (aws, azure, github): regen from
                           latest, diff surface vs committed baseline, print delta + PR
                           label (dry run; --force bypasses the spec cache, --format json)

Local:
  emulator <up|down|status>  Boot/stop/inspect configured lexicons' local
                           emulators (Floci etc.); --lexicon <name>, --json,
                           --port, --image, --network, --setting, --loopback;
                           \`chant emulator --help\` lists ports and logins

Servers:
  serve lsp             Start the LSP server (stdio)
  serve mcp             Start the MCP server (stdio); --read-only serves only
                        the tools that read (ledger, graph, runs) and run nothing

Project:
  update (alias: sync)  Sync lexicon types into .chant/types/ (does not install
                        packages: run npm install first)
  doctor                Check project health and configuration

Options:
  -o, --output <file>   Write output to file instead of stdout
  -f, --format <fmt>    Output format (command-specific):
                        - build: json (default) or yaml
                        - list: text (default) or json
                        - lint: stylish (default), json, or sarif
      --lexicon-output <lexicon>=<path>
                        build: write that lexicon's output to its own file
                        (repeatable). Lexicons not named go to --output when
                        given, and are skipped otherwise
  -d, --lexicon <name>  Build only the specified lexicon (e.g. aws, gitlab);
                        import: use this lexicon instead of detecting one
      --env <name>      Active environment: sets CHANT_ENV so env-aware source
                        re-evaluates for that environment (build + graph), and
                        drives organizational policy. Must be in chant.config
                        \`environments\` when declared.
  -t, --template <name> Init template (e.g. node-pipeline, docker-build);
                        records its lineage in .chant/workspace.lock.json
  --skill <name>        Init: install only this skill from the lexicon
  --skip-mcp            Init: scaffold without writing the project's .mcp.json
  --mcp-read-only       Init: register \`chant serve mcp --read-only\` in .mcp.json
  --fix                 Auto-fix fixable issues (lint command)
  --force               Force overwrite existing files (import command)
  -w, --watch           Watch for changes and rebuild/re-lint (build, lint)
  -v, --verbose         Show stack traces on errors; (build) list every
                        resolved build parameter and per-file fold decision
                        instead of the one-line summaries
  -h, --help            Show this help message
  -V, --version         Print the installed chant's version
  --on <lexicon>        Which runtime hosts the run: a configured lexicon with
                        an opRuntime, or local. Omitted, run.on in
                        chant.config.ts decides, then the built-in local
                        runtime (every run subcommand; #2121, #2523)
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
  --from <name>         Source for migrate: a lexicon, or lexicon/dialect such
                        as sql/postgres (default: github)
  --to <name>           Target for migrate, same form, such as sql/clickhouse
                        (default: gitlab)
  --emit <fmt>          Migration output format: yaml (default), ts, or sql;
                        sql/clickhouse defaults to ts
  --strict              Escalate needs-review/validation to errors (migrate);
                        exit nonzero on an unresolved identity (lifecycle whoami)
  --validate            Run external validator after migrate: glci/glab, or the
                        ClickHouse emulator for sql/clickhouse
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
  --no-record           (run <op>, run --components) Run every step but record
                        nothing on chant/lifecycle and push nothing: no
                        release, run record, receipt or gate fact. A gate
                        step fails. The run says so at its start and end.
                        CHANT_NO_RECORD=1 does the same for a whole CI job
                        (#3955)
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
                        components redeploy, components pr-env up,
                        release cut) Bind a
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
                        components redeploy, components pr-env up,
                        release cut) JSON file
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
  chant import manifest.yaml --lexicon k8s --output ./infra/
  chant import dash.json --lexicon grafana --parser-option acceptLossyV1
  chant import --from prod --name my-bucket --output src/
  chant import --index index.json --type AWS::S3::Bucket --output src/imported/
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
async function loadPluginsOrExit(path: string, lexicon?: string): Promise<import("../lexicon").LexiconPlugin[]> {
  let plugins;
  try {
    // chant #3648 — `--lexicon <name>` loads that lexicon even when the
    // project's config and imports name none.
    const lexiconNames = await resolveProjectLexicons(resolve(path), { lexicon });
    plugins = await loadPlugins(lexiconNames);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // #4116: a lexicon package the project has not installed is named as such first.
    const { reportUninstalledDependencies } = await import("./dependencies");
    reportUninstalledDependencies([errorMessage], resolve(path));
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
 * generated app repo can be this shape: its lexicons are all under a
 * delivery directory, not the root. `chant serve mcp` starts there instead of
 * refusing with "No lexicon detected", and serves core with the chant
 * members' lexicons.
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
 *
 * `words` (#4550) are a CI product's words (`@intentius/chant/ci-product`):
 * the product's bin passes them, so the command renders in the product's
 * words while it runs. `mcp` (#4555) is its tool hook, which `chant serve
 * mcp` serves beside chant's own tools.
 */
export async function runCommandInProcess(
  argv: string[],
  options: { words?: CiProductWordsInput | CiProductWords; mcp?: import("./mcp/product-tools").ProductMcpHook; wave?: import("../op/op-waves-after-plan").ProductWaveHook } = {},
): Promise<number> {
  // #4614: a product's after-plan hooks and capabilities on `chant run wave`, in its own process.
  if (options.wave) {
    const { withProductWaveHook } = await import("../op/op-waves-after-plan");
    const { wave, ...rest } = options;
    return withProductWaveHook(wave, () => runCommandInProcess(argv, rest));
  }
  // #4555: a product's tools on `chant serve mcp`, through its tool hook.
  if (options.mcp) {
    const { withProductMcpHook } = await import("./mcp/product-tools");
    const { mcp, ...rest } = options;
    return withProductMcpHook(mcp, () => runCommandInProcess(argv, rest));
  }
  // #4550: a product's bin calls chant with its words; every status, note and
  // approve line the command writes takes them, and the earlier words come
  // back once it settles.
  if (options.words) return withProductWords(options.words, () => runCommandInProcess(argv));
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
  const plugins = match.def.requiresPlugins ? await loadPluginsOrExit(match.compound ? "." : args.path, args.lexicon) : [];
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
  // #4297 — SQL over the snapshots, runs, gates, deploys and releases on chant/lifecycle. Imported on first use.
  { name: "query", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/query")).runQueryCommand(ctx) },
  { name: "ledger", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/ledger")).runLedgerCommand(ctx) },
  // chant#4532 — a read-only cloud index. main() hands `index`'s raw argv to
  // its own parser before parseArgs; this entry answers "is it a verb" and
  // runs the words a caller already parsed (substrate, --json, --help).
  { name: "index", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/index-cloud")).runIndexCommand(ctx) },
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
  // #3573 — which commits passed CI, kept as ci/green and ci/revoked tags (ws-103). Imported on first use.
  { name: "ci last-green", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/ci-green-cli")).runCiLastGreen(ctx) },
  { name: "ci list", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/ci-green-cli")).runCiList(ctx) },
  { name: "ci tick", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/ci-green-cli")).runCiTick(ctx) },
  { name: "ci workflow", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/ci-green-cli")).runCiWorkflow(ctx) },
  { name: "ci init", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/ci-init")).runCiInit(ctx) },
  // #4556: the ci.hooks.check hooks at base, for a product's check job.
  { name: "ci check", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/ci-check")).runCiCheck(ctx) },
  // #4608: the live forge, cloud trust policies and Pulumi Cloud's OIDC policies against ci.identity.cloud. Read-only.
  // #4624: the apply-job guard, from the expectation the job carries.
  { name: "ci check-job", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/ci-check-job")).runCiCheckJob(ctx) },
  { name: "ci forge-check", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/ci-forge-check")).runCiForgeCheck(ctx) },
  // #4094: one pull-request job as a pipeline Op in a fresh checkout, the chant runner's first slice.
  { name: "ci run", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/ci-run")).runCiRun(ctx) },
  // #4098: the run index at the report URL.
  // #4147: a provisioner's signed word that it started a runner for one job, signed and checked.
  { name: "ci runner-start", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/ci-runner-start")).runCiRunnerStart(ctx) },
  { name: "ci runs", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/ci-run-index")).runCiRuns(ctx) },
  { name: "ci serve", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/ci-serve")).runCiServe(ctx) },
  // #4026: the release cut from a green commit (ws-104). Imported on first use.
  { name: "release cut", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/release")).runReleaseCut(ctx) },
  // #4027: publish a cut release, to the targets #4047 declares.
  { name: "release publish", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/release")).runReleasePublish(ctx) },
  // #4049: check a release's signature offline.
  { name: "release verify", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/release")).runReleaseVerify(ctx) },
  { name: "release workflow", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/release-workflow")).runReleaseWorkflow(ctx) },
  // #4168 4.3: mode (b), chosen changes composed onto a base on chant/compose/<name>.
  { name: "release compose", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/release")).runReleaseCompose(ctx) },
  { name: "release candidates", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/release")).runReleaseCandidates(ctx) },
  { name: "release list", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/release")).runReleaseList(ctx) },
  { name: "release export", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/release")).runReleaseExport(ctx) },
  { name: "release compile", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/release")).runReleaseCompile(ctx) },
  // #3188 — the grouped plan summary of a change-set document. Reads one file; imported on first use.
  { name: "change-set summary", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/change-set")).runChangeSetSummary(ctx) },
  // #4022: the change set a gate bound, read from chant/lifecycle by its digest.
  { name: "change-set show", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/change-set")).runChangeSetShow(ctx) },
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
  { name: "run events", handler: runOpEvents },
  { name: "run wave", handler: runOpWaveCommand },
  // #3683 — start the CI jobs that wait at gates whose approval arrived. Imported on first use.
  { name: "run resume", handler: async (ctx) => (await import("./handlers/gate-resume")).runResumeCommand(ctx) },
  // #4607 — the pending gates a plan digest waits at, with their pull request. Imported on first use.
  { name: "run pending", handler: async (ctx) => (await import("./handlers/gate-pending")).runPendingCommand(ctx) },
  { name: "run", handler: runOp },

  { name: "operator status", handler: runOperatorStatus },
  { name: "operator log", handler: runOperatorLog },
  { name: "operator", handler: runOperator },
  { name: "approve", handler: runApprove },
  // #4293 — target locks a pull request holds on chant/lifecycle. Imported on first use.
  // #4611 — approve a waiting gate from a chat click. Imported on first use.
  { name: "audit-log attribute", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/audit-log")).runAuditLogAttribute(ctx) },
  { name: "audit-log unrecorded", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/audit-log")).runAuditLogUnrecorded(ctx) },
  { name: "notify relay", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/notify-relay")).runNotifyRelay(ctx) },
  { name: "lock", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/lock")).runLock(ctx) },
  { name: "unlock", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/lock")).runUnlock(ctx) },

  { name: "graph", handler: runGraph },
  { name: "vendor", handler: runVendor },
  // Project-local codegen: typed code from sources chant.config declares
  // (k8s.crds, helm.charts). Imported on first use.
  { name: "generate", requiresPlugins: true, handler: async (ctx) => (await import("./handlers/generate")).runGenerate(ctx) },

  // Workspace reads (#2524). Imported on first use, so a level-0 command never
  // loads anything under workspace/ (#2525 rule 5, pinned by #2526's goldens).
  // #3276 — records, points, ls and status read the declaration and never the
  // config of the member they run in, so they skip its load (and tsx with it).
  { name: "workspace records", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/records-cli")).runWorkspaceRecords(ctx) },
  // ws-058 (#2739) — decision points and the questions asked of them; never calls a model.
  { name: "workspace points", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/points-cli")).runWorkspacePoints(ctx) },
  { name: "workspace init", handler: async (ctx) => (await import("../workspace/init")).runWorkspaceInit(ctx) },
  { name: "workspace ls", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/ls")).runWorkspaceLs(ctx) },
  // #2732 — the work lease: claim, renew and release a work item.
  { name: "workspace work", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/work-cli")).runWorkspaceWork(ctx) },
  // #3033 — the agent run record: what each run cost and which commits it made. chant records runs and never starts one.
  { name: "workspace runs", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/runs-cli")).runWorkspaceRuns(ctx) },
  // #4039 — DORA metrics from the deploy, release and revocation records.
  { name: "workspace metrics", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/delivery-metrics")).runWorkspaceMetrics(ctx) },
  { name: "workspace status", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/status")).runWorkspaceStatus(ctx) },
  { name: "workspace lineage", handler: async (ctx) => (await import("../workspace/lineage-cli")).runWorkspaceLineage(ctx) },
  { name: "workspace exit", handler: async (ctx) => (await import("../workspace/exit-cli")).runWorkspaceExit(ctx) },
  // #3178 — move a member one rung up the kind ladder, staged in a worktree and gated on the patch digest.
  { name: "workspace promote", handler: async (ctx) => (await import("../workspace/promote")).runWorkspacePromote(ctx) },
  { name: "workspace upgrade", handler: async (ctx) => (await import("../workspace/lineage-upgrade-cli")).runWorkspaceUpgrade(ctx) },
  // #2551 — adopt a lineage, the hash index it matches against, and the versions of a family of workspaces.
  { name: "workspace adopt-lineage", handler: async (ctx) => (await import("../workspace/lineage-adopt-cli")).runWorkspaceAdoptLineage(ctx) },
  { name: "workspace hash-index", handler: async (ctx) => (await import("../workspace/lineage-adopt-cli")).runWorkspaceHashIndex(ctx) },
  // #2552 — export a workspace or members, bring an export back, and admit a return's signers.
  { name: "workspace export", handler: async (ctx) => (await import("../workspace/export-cli")).runWorkspaceExport(ctx) },
  { name: "workspace import", handler: async (ctx) => (await import("../workspace/export-cli")).runWorkspaceImport(ctx) },
  { name: "workspace admit", handler: async (ctx) => (await import("../workspace/export-cli")).runWorkspaceAdmit(ctx) },
  { name: "workspace versions", handler: async (ctx) => (await import("../workspace/lineage-versions")).runWorkspaceVersions(ctx) },
  // #2641 — workspace check reads member configs statically and never runs one.
  { name: "workspace check", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/lineage-check")).runWorkspaceCheck(ctx) },
  // The hunks of a diff, for a reader that runs no git of its own.
  { name: "workspace patch", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/patch")).runWorkspacePatch(ctx) },
  // #2537 — per-member commands. Each member runs under its own chant, one
  // process per toolchain identity; `member-run` is that process's entry.
  { name: "workspace build", handler: async (ctx) => (await import("../workspace/member-commands")).runWorkspaceMembers(ctx, "build") },
  { name: "workspace lint", handler: async (ctx) => (await import("../workspace/member-commands")).runWorkspaceMembers(ctx, "lint") },
  // chant#2618 — audit runs no project code, at the workspace level too.
  { name: "workspace audit", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/member-commands")).runWorkspaceMembers(ctx, "audit") },
  { name: "workspace graph", handler: async (ctx) => (await import("../workspace/member-commands")).runWorkspaceMembers(ctx, "graph") },
  // #4374 — chant search in every member, under its own chant, composed with workspace graph's ids: the search document.
  // #2554 — Ops that span members, as <member>/<op> targets, each run under its member's own chant.
  { name: "workspace run", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/workspace-run")).runWorkspaceRun(ctx) },
  // #2554 — a release train: one release of every chant member, pinned in the workspace ledger.
  { name: "workspace train", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/release-train")).runWorkspaceTrain(ctx) },
  { name: "workspace drift", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/drift-cli")).runWorkspaceDrift(ctx) },
  { name: "workspace search", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/search-cli")).runWorkspaceSearch(ctx) },
  // Each unit decides for itself whether its config is loaded (runCommandInProcess).
  { name: "workspace member-run", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/member-run")).runWorkspaceMemberRun(ctx, runCommandInProcess) },
  // #3308 — a box's listing, written through chant so a tool never edits the declaration itself (ws-074).
  { name: "workspace box", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/box-cli")).runWorkspaceBox(ctx) },
  // #3596 — a declaration's members and hosts, written through chant so a lobby never edits the declaration itself (ws-074).
  { name: "workspace member", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/declaration-write-cli")).runWorkspaceMember(ctx) },
  { name: "workspace host", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/declaration-write-cli")).runWorkspaceHost(ctx) },
  // #3173 — the working tree's write lock, held across chant calls for a batch of writes (ws-089).
  { name: "workspace lock", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/write-lock-cli")).runWorkspaceLock(ctx) },
  // #3172 — work in progress under refs/chant/wip/<branch>, replicated under the box's policy (ws-085).
  { name: "workspace wip", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/wip-cli")).runWorkspaceWip(ctx) },
  { name: "workspace pin", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/pin-cli")).runWorkspacePin(ctx) },
  // #2548 — an agent session's member, write scope and spec, for a session that resumes.
  { name: "workspace agent", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/agent-cli")).runWorkspaceAgent(ctx) },
  { name: "workspace verify", handler: async (ctx) => (await import("../workspace/trust/verify-cli")).runWorkspaceVerify(ctx) },
  // #3510 — a runner entry of .chant/trust.json, written through chant so a box repo never edits it by hand (ws-074).
  { name: "workspace trust", runsNoConfig: true, handler: async (ctx) => (await import("../workspace/trust/trust-write")).runWorkspaceTrust(ctx) },
  { name: "workspace signers", handler: async (ctx) => (await import("../workspace/trust/signers-cli")).runWorkspaceSigners(ctx) },
  { name: "workspace evidence", handler: async (ctx) => (await import("../workspace/trust/evidence-cli")).runWorkspaceEvidence(ctx) },

  // State subcommands
  { name: "lifecycle snapshot", requiresPlugins: true, handler: runLifecycleSnapshot },
  { name: "lifecycle show", handler: runLifecycleShow },
  { name: "lifecycle diff", requiresPlugins: true, handler: runLifecycleDiff },
  { name: "lifecycle rollback", handler: runLifecycleRollback },
  { name: "lifecycle plan", requiresPlugins: true, handler: runLifecyclePlan },
  { name: "lifecycle affected", requiresPlugins: true, handler: runLifecycleAffected },
  { name: "lifecycle drift", requiresPlugins: true, handler: async (ctx) => (await import("./handlers/lifecycle-drift")).runLifecycleDrift(ctx) },
  { name: "lifecycle whoami", requiresPlugins: true, handler: runLifecycleWhoami },
  // #4177 — runtime health, separate from drift. Imported on first use.
  { name: "lifecycle health", requiresPlugins: true, handler: async (ctx) => (await import("./handlers/lifecycle-health")).runLifecycleHealth(ctx) },
  { name: "lifecycle teardown", requiresPlugins: true, handler: runLifecycleTeardown },
  { name: "lifecycle log", handler: runLifecycleLog },
  // #4036 — retention's garbage collection. Imported on first use.
  { name: "lifecycle gc", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/lifecycle-gc")).runLifecycleGc(ctx) },

  // Plan scenarios (#1292) — fully offline, no plugin network calls, but
  // requiresPlugins:true so the build step has serializers to partition
  // against, same as every other build-then-something verb.
  { name: "scenario check", requiresPlugins: true, handler: runScenarioCheck },

  // Component release ledger + status surface (#568, epic #551)
  { name: "components fan-out", requiresPlugins: true, handler: runComponentsFanOut },
  // #3183 — the pull-request loop the generated CI runs. Imported on first use.
  { name: "components pr-plan", requiresPlugins: true, handler: async (ctx) => (await import("./handlers/pr")).runComponentsPrPlan(ctx) },
  { name: "components pr-apply", requiresPlugins: true, handler: async (ctx) => (await import("./handlers/pr")).runComponentsPrApply(ctx) },
  // #4588: the component plan-wave and apply-wave steps a component waves spec runs (pr-apply --wave-gate on op waves).
  { name: "components plan-wave", requiresPlugins: true, handler: async (ctx) => (await import("./handlers/pr")).runComponentsPlanWave(ctx) },
  { name: "components apply-wave", requiresPlugins: true, handler: async (ctx) => (await import("./handlers/pr")).runComponentsApplyWave(ctx) },
  // #4295: posts from the plan report in a job that runs none of the change's code, so it loads no plugins.
  { name: "components pr-post", handler: async (ctx) => (await import("./handlers/pr")).runComponentsPrPost(ctx) },
  { name: "components pr-record", requiresPlugins: true, handler: async (ctx) => (await import("./handlers/pr")).runComponentsPrRecord(ctx) },
  // #4616: the agent jobs' three steps. Imported on first use; none loads plugins.
  { name: "agent prepare", handler: async (ctx) => (await import("./handlers/agent")).runAgentCommandLine(ctx) },
  { name: "agent run", handler: async (ctx) => (await import("./handlers/agent")).runAgentCommandLine(ctx) },
  { name: "agent land", handler: async (ctx) => (await import("./handlers/agent")).runAgentCommandLine(ctx) },
  { name: "components pr-env", requiresPlugins: true, handler: async (ctx) => (await import("./handlers/pr-env")).runComponentsPrEnv(ctx) },
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
  { name: "release", runsNoConfig: true, handler: async (ctx) => (await import("./handlers/release")).runReleaseUnknown(ctx) },
  { name: "workspace", handler: async (ctx) => (await import("../workspace/records-cli")).runWorkspaceUnknown(ctx) },
];

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // #3878 — run from dist/ with plain node, TypeScript loads only when
  // something imports it. A no-op from source.
  installCompiledCli();
  const rawArgv = process.argv.slice(2);

  // chant#4532 — `chant index <substrate>` takes its own flags (--account,
  // --regions, --endpoint, ...) that core's one flat parser does not know, and
  // must refuse an action flag (--apply, --yes, ...) that the parser would
  // accept. So its argv goes to its own parser, before parseArgs.
  if (rawArgv[0] === "index" && rawArgv[1] === "diff") {
    // #4533 — `chant index diff <a> [<b>]`: two stored versions of one scope.
    const { runIndexDiff } = await import("./handlers/index-diff");
    await flushAndExit(await runIndexDiff(rawArgv.slice(2)));
    return;
  }
  if (rawArgv[0] === "index") {
    const { runCloudIndex } = await import("../lifecycle/cloud-index");
    await flushAndExit(await runCloudIndex(rawArgv.slice(1)));
    return;
  }

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

  // #3673 — `chant emulator --help` is the emulator's own usage, with the
  // ports and sign-in each configured lexicon's emulator uses, not the
  // global command list it used to print.
  if (args.help && args.command === "emulator") {
    console.log((await emulatorHandlers()).formatEmulatorHelp(await loadPluginsBestEffort().catch(() => [])));
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
  // #3878 — load the command's own modules (and the plugin loader, when it
  // needs plugins) before anything imports TypeScript: once a chant.config.ts
  // has registered tsx, every module after it is resolved and loaded through
  // tsx's hooks, which costs far more than plain node.
  await Promise.all([
    earlyMatch ? handlerModules.get(earlyMatch.def.handler)?.() : undefined,
    earlyMatch?.def.requiresPlugins ? import("./plugins") : undefined,
  ]);
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
        : await loadPluginsOrExit(projectPath, args.lexicon)
    : [];
  const serializers = plugins.map((p) => p.serializer);
  const ctx = { args, plugins, serializers };

  await flushAndExit(await match.def.handler(ctx));
}

// Only run main when executed directly, not when imported. Robust to symlinked
// invocation paths — see isEntryPoint (a raw string compare silently no-ops the
// whole CLI through the npm .bin shim / a symlinked checkout).
const isMain = isEntryPoint(process.argv[1], import.meta.url);
if (isMain) {
  main().catch(async (err) => {
    const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
    // #4116: a failure to import a package the project has not installed is named as such first.
    try {
      const { reportUninstalledDependencies } = await import("./dependencies");
      reportUninstalledDependencies([err instanceof Error ? err.message : String(err)], process.cwd());
    } catch {
      // The original error below is what matters.
    }
    if (verbose && err instanceof Error && err.stack) {
      console.error(err.stack);
    } else {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    }
    await flushAndExit(1);
  });
}
