/**
 * The command-line parser every chant entry shares: the full CLI (`./main.ts`)
 * and the slim wave-job runtime (`../wave-runtime.ts`, #3896). It lives on its own
 * so the runtime bundles the same parser without the command registry.
 */
import { splitJoinedFlags } from "./command-group";
import type { ParsedArgs } from "./registry";

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
  "--open",
  "--version",
  "--agents",
  "--agent",
  "--all-projects",
  "--all",
  "--force",
  "--fix",
  "--watch",
  "--verbose",
  "--live",
  "--overlay",
  "--explain",
  "--owned",
  "--verbatim",
  "--skip-undeclarable",
  "--apply-rewrites",
  "--write",
  "--strict",
  "--validate",
  "--use-composites",
  "--composites",
  "--stacks",
  "--components",
  "--pr-build",
  "--pr-env",
  "--up",
  "--down",
  "--include-dependents",
  "--cross-root",
  "--local",
  "--json",
  "--progress-json",
  "--events-json",
  "--follow",
  "--update-snapshot",
  "--update-baseline",
  "--run-examples",
  "--check",
  "--bump",
  "--no-release-record",
  "--no-record",
  "--fold",
  "--no-fold",
  "--no-cache",
  "--sandbox",
  "--yes",
  "--confirm-prod",
  "--once",
  "--rerun-failed",
  "--setup-key",
  "--trust",
  "--unsigned",
  "--in-place",
  "--require-runner-start",
  "--require-clouds",
  "--no-push",
  "--list",
  "--no-require-review",
  "--expire",
  "--check-live",
  "--stream",
  "--check-snapshot",
  "--fail-on-drift",
  "--durable-requests",
  "--skip-mcp",
  "--read-only",
  "--mcp-read-only",
  "--propose",
  "--current",
  "--uncommitted",
  "--allow-code",
  "--allow-skip",
  "--allow-unsigned",
  "--require-provenance",
  "--root-only",
  "--generated",
  "--decide",
  "--record-plans",
  "--approval-status",
  "--waves-outcome",
  "--loopback",
  "--artifacts",
  "--push",
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
    readOnly: undefined,
    mcpReadOnly: undefined,
    propose: undefined,
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
  //
  // Tokens after a bare `--` are positionals (#4369), so they are not split.
  const end = args.indexOf("--");
  args = end < 0 ? splitJoinedFlags(args, BOOLEAN_FLAGS) : [...splitJoinedFlags(args.slice(0, end), BOOLEAN_FLAGS), ...args.slice(end)];

  // chant #4369 — every token after a bare `--` is a positional, whatever it
  // starts with: `chant search -- "-kind:X"` is the spelling that always works.
  let onlyPositionals = false;
  const positional = (arg: string): void => {
    if (result.command) (result.positionals ??= []).push(arg);
    if (!result.command) {
      result.command = arg;
    } else if (result.path === ".") {
      result.path = arg;
    } else if (!result.extraPositional) {
      result.extraPositional = arg;
    } else {
      result.extraPositional2 = arg;
    }
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (onlyPositionals) {
      positional(arg);
    } else if (arg === "--") {
      onlyPositionals = true;
    } else if (arg === "--help" || arg === "-h") {
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
    } else if (arg === "--scan") {
      // `chant e2e safe-run --scan <dir> -- <command...>` (chant#4587), repeatable.
      const v = args[++i];
      if (v === undefined || v === "--" || v.startsWith("--")) throw new Error("--scan needs a directory: --scan <dir>");
      (result.scanDirs ??= []).push(v);
    } else if (arg === "--from") {
      // Shared by `migrate --from <lexicon>`, `import --from <env>`,
      // `components promote --from <env>`, `init --from <repo>@<ref>` and
      // `ci last-green --from <rev>` (#4031); the commands never run
      // together, so one field carries all five.
      result.migrateFrom = args[++i];
    } else if (arg === "--kustomize") {
      // `chant import --kustomize <dir>` (#1548): render the overlay, import
      // the output through the k8s template parser.
      result.kustomize = args[++i];
    } else if (arg === "--parser-option") {
      // `chant import --parser-option key[=value]` (#2994), repeatable: checked
      // against the lexicon's parserOptions() by the import command.
      const v = args[++i];
      if (!v || v.startsWith("-")) throw new Error("--parser-option needs key or key=value: --parser-option acceptLossyV1");
      (result.parserOption ??= []).push(v);
    } else if (arg === "--tag") {
      // `chant import --index <ref> --tag key=value` (#4524), repeatable: every tag must match.
      const v = args[++i];
      if (!v || v.startsWith("-") || !v.includes("=")) throw new Error("--tag needs key=value: --tag team=payments");
      (result.selectTags ??= []).push(v);
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
    } else if (arg === "--skip-undeclarable") {
      result.skipUndeclarable = true;
    } else if (arg === "--state") {
      result.statePath = args[++i];
      // `chant workspace promote --all --state <member>=<path>` (#4461), repeatable.
      if (result.statePath !== undefined) (result.statePaths ??= []).push(result.statePath);
    } else if (arg === "--state-dir") {
      // `chant workspace promote --all --state-dir <dir>` (#4461): <dir>/<member>.tfstate.
      result.stateDir = args[++i];
      if (!result.stateDir || result.stateDir.startsWith("-")) throw new Error("--state-dir needs a directory: --state-dir <dir>");
    } else if (arg === "--wave-size") {
      const raw = args[++i];
      const size = Number(raw);
      if (!Number.isInteger(size) || size < 1) throw new Error(`--wave-size needs a whole number from 1: got "${raw ?? ""}"`);
      result.waveSize = size;
    } else if (arg === "--all") {
      // `chant workspace promote --all` (#4461): every terraform member.
      result.all = true;
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
    } else if (arg === "--drill") {
      // #3177 — `chant workspace exit --drill` runs the exit on a scratch copy.
      result.drill = true;
    } else if (arg === "--yes") {
      result.yes = true;
    } else if (arg === "--push") {
      // `chant lifecycle gc --yes --push` (#4036): push the prune commit.
      result.push = true;
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
    } else if (arg === "--read-only") {
      result.readOnly = true;
    } else if (arg === "--mcp-read-only") {
      result.mcpReadOnly = true;
    } else if (arg === "--propose") {
      result.propose = true;
    } else if (arg === "--src") {
      result.src = args[++i];
    } else if (arg === "--env") {
      result.env = args[++i];
    } else if (arg === "--port") {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("--port needs a port: --port <container-port>=<host-port>");
      (result.port ??= []).push(value);
    } else if (arg === "--image") {
      result.image = args[++i];
      if (!result.image || result.image.startsWith("-")) throw new Error("--image needs an image reference: --image <name>:<tag>");
    } else if (arg === "--network") {
      result.network = args[++i];
      if (!result.network || result.network.startsWith("-")) throw new Error("--network needs a Docker network name: --network <name>");
    } else if (arg === "--setting") {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("--setting needs a value: --setting <KEY>=<VALUE>");
      (result.setting ??= []).push(value);
    } else if (arg === "--loopback") {
      result.loopback = true;
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
    } else if (arg === "--keep") {
      // `chant lock --keep --pr <n>` (#4588): keep the locks the pull request's plan took, as `/<product> lock` asks.
      result.keepLocks = true;
    } else if (arg === "--runs" || arg === "--plans" || arg === "--wave-outputs") {
      // `chant components plan-wave|apply-wave` (#4588): the op-waves runs and plans files, and the outputs the waves hand on.
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) throw new Error(`${arg} needs a file`);
      result[({ "--runs": "runsFile", "--plans": "plansFile", "--wave-outputs": "waveOutputs" } as const)[arg]] = value;
    } else if (arg === "--detail") {
      result.detail = Number(args[++i]);
    } else if (arg === "--lens") {
      result.lens = args[++i];
    } else if (arg === "--explain") {
      result.explain = true;
    } else if (arg === "--show") {
      result.show = args[++i];
    } else if (arg === "--count-by") {
      // `chant search --count-by kind|module|attr:<name>` (#4360)
      result.countBy = args[++i];
      if (!result.countBy || result.countBy.startsWith("-")) throw new Error("--count-by needs a grouping: --count-by kind, --count-by module or --count-by attr:<name>");
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
    } else if (arg === "--cross-root") {
      // `chant workspace lint --cross-root` (#2549): the disagreement lint over every member's graph.
      result.crossRoot = true;
    } else if (arg === "--dependents-of") {
      // `chant workspace run --dependents-of <member> --op <op>` (#2554).
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("--dependents-of needs a member name: --dependents-of <member>");
      result.dependentsOf = value;
    } else if (arg === "--pin") {
      // `chant workspace train <env> --pin <member>=<label|digest>` (#2554), repeatable.
      const value = args[++i];
      if (!value || value.startsWith("-") || !value.includes("=")) throw new Error("--pin needs a member and a release: --pin <member>=<label|digest>");
      (result.pins ??= []).push(value);
    } else if (arg === "--from-affected") {
      result.fromAffected = args[++i];
    } else if (arg === "--gate") {
      result.gate = args[++i];
    } else if (arg === "--wave-gate") {
      result.waveGate = args[++i];
      if (!result.waveGate || result.waveGate.startsWith("-")) throw new Error("--wave-gate needs a gate name: --wave-gate <name>");
    } else if (arg === "--wave") {
      const raw = args[++i];
      const wave = Number(raw);
      if (!Number.isInteger(wave) || wave < 1) throw new Error(`--wave needs a wave number from 1: got "${raw ?? ""}"`);
      result.wave = wave;
    } else if (arg === "--decide") {
      result.decide = true;
    } else if (arg === "--record-plans") {
      result.recordPlans = true;
    } else if (arg === "--approval-status") {
      // `chant run wave --spec <file> --approval-status` (#4630): post <product>/approval on an open pull request's head.
      result.approvalStatus = true;
    } else if (arg === "--waves-outcome") {
      result.wavesOutcome = true;
    } else if (arg === "--group") {
      const raw = args[++i];
      if (!raw || raw.startsWith("-")) throw new Error("--group needs a job group's name: --group <name>");
      result.group = raw;
    } else if (arg === "--share") {
      const raw = args[++i];
      const share = Number(raw);
      if (!Number.isInteger(share) || share < 1) throw new Error(`--share needs a share number from 1: got "${raw ?? ""}"`);
      result.share = share;
    } else if (arg === "--target") {
      // `chant components fan-out|run --components --target <component>:<address>` (#4300), repeatable.
      // `chant components pr-plan --target <address>` (#4620) also takes a bare address; fan-out and run refuse one.
      const raw = args[++i];
      if (!raw || raw.startsWith("-")) throw new Error("--target needs an address: --target <component>:<address>, or on pr-plan --target <address>");
      (result.targets ??= []).push(raw);
    } else if (arg === "--refresh") {
      // `chant components pr-plan --refresh` (#4627).
      result.refresh = true;
    } else if (arg === "--target-dependents") {
      // `chant components pr-plan --target-dependents` (#4627).
      result.targetDependents = true;
    } else if (arg === "--comment-targets") {
      // `chant components pr-plan --comment-targets` (#4626): the preview comment's --target addresses.
      result.commentTargets = true;
    } else if (arg === "--parallelism") {
      // `chant components pr-plan --parallelism <n>` (#4625): members of a wave planned at once.
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--parallelism needs a whole number of 1 or more: got "${raw ?? ""}"`);
      result.parallelism = n;
    } else if (arg === "--canary") {
      const raw = args[++i];
      if (!raw || raw.startsWith("-")) throw new Error("--canary needs a component name: --canary <name>[,<name>...]");
      (result.canary ??= []).push(...raw.split(",").map((n) => n.trim()).filter(Boolean));
    } else if (arg === "--pr") {
      const raw = args[++i];
      const pr = Number(raw);
      if (!Number.isInteger(pr) || pr < 1) throw new Error(`--pr needs a pull or merge request number: got "${raw ?? ""}"`);
      result.pr = pr;
      // `chant release compose --pr <n>...` (#4168 4.3) reads every one.
      (result.prs ??= []).push(pr);
    } else if (arg === "--channel") {
      // `chant release cut --channel <tag>` (#4168 4.3): the tag a publish moves in place of latest.
      result.channel = args[++i];
      if (!result.channel || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(result.channel)) throw new Error(`--channel needs a channel name, such as next or hotfix: got "${result.channel ?? ""}"`);
    } else if (arg === "--forge") {
      result.forge = args[++i];
      if (!result.forge || result.forge.startsWith("-")) throw new Error("--forge needs a forge: --forge github|gitlab|forgejo");
    } else if (arg === "--require-clouds") {
      // `chant ci forge-check --require-clouds` (#4608).
      result.requireClouds = true;
    } else if (arg === "--require-review") {
      result.requireReview = true;
    } else if (arg === "--list") {
      // `chant lock --list` (#4293): print the target locks instead of taking any.
      result.list = true;
    } else if (arg === "--stage") {
      // `chant lock --stage plan|apply|lock` (#4293): how the lock was taken.
      result.lockStage = args[++i];
      if (!result.lockStage || result.lockStage.startsWith("-")) throw new Error("--stage needs plan, apply or lock: --stage <stage>");
    } else if (arg === "--alive") {
      // `chant lock --alive <run>` (#4552): print whether a run holding rows or the repo lock tag still runs.
      result.aliveRun = args[++i];
      if (!result.aliveRun || result.aliveRun.startsWith("-")) throw new Error("--alive needs a run id: --alive <run>");
    } else if (arg === "--beat") {
      // `chant lock --beat <run> --parent <pid>` (#4660): the heartbeat side process of a row hold.
      result.beatRun = args[++i];
      if (!result.beatRun || result.beatRun.startsWith("-")) throw new Error("--beat needs a run id: --beat <run> --parent <pid>");
    } else if (arg === "--parent") {
      const pid = Number(args[++i]);
      if (!Number.isInteger(pid) || pid < 1) throw new Error("--parent needs a process id: --parent <pid>");
      result.parentPid = pid;
    } else if (arg === "--run") {
      // `chant unlock --run <id>` (#4660): free the rows a run holds or waits for.
      result.unlockRun = args[++i];
      if (!result.unlockRun || result.unlockRun.startsWith("-")) throw new Error("--run needs a run id: --run <id>");
    } else if (arg === "--from-report") {
      // `chant lock --from-report <pr-plan.json>` (#4293): lock the components a pull-request report lists.
      result.fromReport = args[++i];
      if (!result.fromReport || result.fromReport.startsWith("-")) throw new Error("--from-report needs a report file: --from-report <pr-plan.json>");
    } else if (arg === "--report-url") {
      // `chant components pr-plan|pr-apply --report-url <url>` (#4007).
      const url = args[++i];
      if (!url || url.startsWith("-")) throw new Error("--report-url needs a URL: --report-url s3://<bucket>/<prefix>, gs://<bucket>/<prefix>, az://<account>/<container>/<prefix> or file://<directory>");
      result.reportUrl = url;
    } else if (arg === "--result") {
      // `chant components pr-post --result <result>` (#4295): the plan job's own result, which fails the status when it failed.
      result.planResult = args[++i];
      if (!result.planResult || result.planResult.startsWith("-")) throw new Error("--result needs the plan job's result: --result success|failure|cancelled");
    } else if (arg === "--no-status") {
      // `chant ci run|serve --no-status` (#4097): post no commit status for the job.
      result.noStatus = true;
    } else if (arg === "--status-url") {
      // `chant ci run|serve --status-url <template>` (#4097): the link a job's status carries, in place of an https --report-url.
      result.statusUrl = args[++i];
      if (!result.statusUrl || result.statusUrl.startsWith("-")) throw new Error("--status-url needs a URL template: --status-url https://host/reports/{key}");
    } else if (arg === "--allow-unsigned") {
      // `chant release publish --allow-unsigned` (#4049).
      result.allowUnsigned = true;
    } else if (arg === "--require-provenance") {
      // `chant release publish --require-provenance` (#4049).
      result.requireProvenance = true;
    } else if (arg === "--pr-loop") {
      result.prLoop = true;
    } else if (arg === "--green") {
      // `chant components pr-apply --green` (#4168 step 9): apply the green commit at HEAD.
      result.green = true;
    } else if (arg === "--before-merge") {
      // `chant components pr-apply --before-merge` (#4301, ws-106): apply an open pull request's plan from its head.
      result.beforeMerge = true;
    } else if (arg === "--requires") {
      // `chant components pr-apply --before-merge --requires approved,checks` (#4607): the checks a product's `apply.requires` names.
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) throw new Error("--requires needs a list of checks: --requires approved,mergeable,undiverged,checks");
      result.requires = value.split(",").map((v) => v.trim()).filter(Boolean);
    } else if (arg === "--respond") {
      // `chant components pr-apply|pr-post --respond wave-refused=off,description=check` (#4629).
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) throw new Error("--respond needs a list of responses: --respond wave-refused=diff,apply-failed=off,description=check");
      result.respond = [...(result.respond ?? []), value];
    } else if (arg === "--decide-backend") {
      // `chant components pr-post --decide-backend <name>` (#4629): the description check's backend.
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) throw new Error("--decide-backend needs the name of a decide.backends entry");
      result.decideBackend = value;
    } else if (arg === "--decide-model") {
      // `chant components pr-post --decide-model <id>` (#4629): the description check's pinned model.
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) throw new Error("--decide-model needs a model id");
      result.decideModel = value;
    } else if (arg === "--merge" || arg === "--merge-token-env" || arg === "--merge-method") {
      // `chant components pr-apply --before-merge --merge auto --merge-token-env <VAR>` (#4636).
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) throw new Error(`${arg} needs a value: --merge manual|auto, --merge-token-env <VAR>, --merge-method merge|squash|rebase`);
      if (arg === "--merge") result.merge = value;
      else if (arg === "--merge-token-env") result.mergeTokenEnv = value;
      else result.mergeMethod = value;
    } else if (arg === "--apply-before-merge") {
      // `chant build --pr-loop --apply-before-merge` and `chant ci run apply --apply-before-merge` (#4301): the job that applies before merge.
      result.applyBeforeMerge = true;
    } else if (arg === "--apply-on-merge") {
      // `chant build --pr-loop --apply-on-merge` and `chant ci serve --apply-on-merge` (#4168): opt into applying on merge.
      result.applyOnMerge = true;
    } else if (arg === "--action-job") {
      // `chant build --pr-loop --action-job` (#4654): the job that answers the action comment and the action dispatch.
      result.actionJob = true;
    } else if (arg === "--preview-comment") {
      // `chant build --pr-loop --preview-comment` (#4620): the job that answers `/<product> <plan word>` with a preview.
      result.previewComment = true;
    } else if (arg === "--pr-env") {
      // `chant build --pr-loop --pr-env` (#4298): add the pull request environment's jobs.
      result.prEnv = true;
    } else if (arg === "--pr-runner") {
      // `chant build --pr-loop --pr-runner <stage>=<label>[,<label>...]` (#4625).
      const raw = args[++i] ?? "";
      const m = /^(plan|apply|default)=(.+)$/.exec(raw);
      if (!m) throw new Error(`--pr-runner needs <stage>=<label>[,<label>...], the stage plan, apply or default: got "${raw}"`);
      const labels = m[2]!.split(",").map((l) => l.trim()).filter(Boolean);
      if (labels.length === 0) throw new Error(`--pr-runner ${m[1]} names no label`);
      (result.prRunners ??= {})[m[1] as "plan" | "apply" | "default"] = labels;
    } else if (arg === "--pr-variable" || arg === "--pr-secret") {
      // `chant build --pr-loop --pr-variable <NAME>=<value>` and `--pr-secret <NAME>=<secret>` (#4625).
      const raw = args[++i] ?? "";
      const at = raw.indexOf("=");
      if (at < 1) throw new Error(`${arg} needs <NAME>=<${arg === "--pr-secret" ? "secret" : "value"}>: got "${raw}"`);
      const into = arg === "--pr-secret" ? (result.prSecrets ??= {}) : (result.prVariables ??= {});
      into[raw.slice(0, at)] = raw.slice(at + 1);
    } else if (arg === "--pr-build") {
      // `chant build --pr-loop --pr-build` (#4088), and `chant ci run --pr-build` (#4094).
      result.prBuild = true;
    } else if (arg === "--build-command") {
      // `chant ci serve --build-command <line>` (#4169): the line that builds a requested commit.
      const line = args[++i];
      if (line === undefined || line === "") throw new Error("--build-command needs a shell line: --build-command '<line>'");
      result.ciBuildCommand = line;
    } else if (arg === "--land") {
      // `chant ci serve --land` (#4168 4.4): fast-forward the target to a chant/land/<name> branch once its pre-merge phases pass.
      result.ciLand = true;
    } else if (arg === "--pr-build-command") {
      const line = args[++i];
      if (line === undefined || line === "") throw new Error("--pr-build-command needs a shell line: --pr-build-command '<line>'");
      result.prBuildCommand = line;
    } else if (arg === "--before-script") {
      const line = args[++i];
      if (line === undefined || line === "") throw new Error("--before-script needs a shell line: --before-script '<line>'");
      (result.beforeScript ??= []).push(line);
    } else if (arg === "--resume") {
      // `chant approve <op> <gate> --resume` (#3683) takes no value; the
      // fan-out and pull-request apply take the attempt file they resume.
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) result.resumeRun = true;
      else result.resume = args[++i];
    } else if (arg === "--local") {
      result.local = true;
    } else if (arg === "--json") {
      result.json = true;
    } else if (arg === "--progress-json") {
      result.progressJson = true;
    } else if (arg === "--events-json") {
      result.eventsJson = true;
    } else if (arg === "--follow") {
      // `chant run events <run> --follow` (#4042): tail a run in progress on this host.
      result.follow = true;
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
    } else if (arg === "--capability-view") {
      // `chant graph --format ir --capability-view` and `chant workspace graph --capability-view` (#4378)
      result.capabilityView = true;
    } else if (arg === "--capabilities") {
      // `chant search --capabilities` and `chant workspace search --capabilities` (#4375)
      result.capabilities = true;
    } else if (arg === "--snapshot") {
      // `chant search` and `chant workspace search --snapshot <ref>` (#4374)
      result.snapshot = args[++i];
      if (!result.snapshot || result.snapshot.startsWith("-")) throw new Error("--snapshot needs a snapshot ref: --snapshot latest");
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
      // `chant workspace graph --intent <path[:start-end]|path#symbol|member/node|sha>` (#2651), or `--intent --record <id>` with no region.
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) result.intent = args[++i];
      else if (args.includes("--record")) result.intent = "";
      else throw new Error("--intent needs a region: --intent <path[:start-end]|path#symbol|member/node|sha>, or --intent --record <id>");
    } else if (arg === "--follow-squash") {
      // `chant workspace graph --intent ... --follow-squash` and `chant workspace runs --follow-squash` (#3035)
      result.followSquash = true;
    } else if (arg === "--forge-issues") {
      // `chant release candidates --forge-issues` and `chant workspace graph --intent ... --forge-issues` (#4649)
      result.forgeIssues = true;
    } else if (arg === "--record") {
      // `chant workspace graph --intent --record <id>`
      result.record = args[++i];
      if (!result.record || result.record.startsWith("-")) throw new Error("--record needs a record id: --record <id>");
    } else if (arg === "--path") {
      // `chant workspace patch <range> --path <p>`, repeatable
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("--path needs a path: --path <path>");
      (result.paths ??= []).push(value);
    } else if (arg === "--worktree") {
      // `chant workspace patch [<commit>] --worktree`
      result.worktree = true;
    } else if (arg === "--max-bytes") {
      // `chant workspace patch <range> --max-bytes <n>`
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error("--max-bytes needs a whole number of bytes above 0");
      result.maxBytes = value;
    } else if (arg === "--changes") {
      // `chant workspace check --changes <base>..<head>` (#2773)
      result.changes = args[++i];
      if (!result.changes || result.changes.startsWith("-")) throw new Error("--changes needs a range: --changes <base>..<head>");
    } else if (arg === "--severity") {
      // `chant workspace check --changes <range> --severity off|warn|fail` (#2773)
      result.severity = args[++i];
      if (!result.severity || result.severity.startsWith("-")) throw new Error("--severity needs off, warn or fail");
    } else if (arg === "--current") {
      result.current = true;
    } else if (arg === "--uncommitted") {
      // `chant workspace records --uncommitted` (#3160)
      result.uncommitted = true;
    } else if (arg === "--set") {
      // `chant workspace records amend <id> --set <file|->` (#2670)
      result.set = args[++i];
      if (!result.set || (result.set.startsWith("-") && result.set !== "-")) throw new Error("--set needs a JSON file, or - for standard input: --set <file|->");
    } else if (arg === "--cover") {
      // `chant workspace box listing set <member> --cover <image>` (#3308)
      result.cover = args[++i];
      if (!result.cover || result.cover.startsWith("-")) throw new Error("--cover needs a PNG, JPEG or WebP file: --cover <image>");
    } else if (arg === "--cover-path") {
      // `chant workspace box listing set <member> --cover <image> --cover-path <path>` (#3308)
      result.coverPath = args[++i];
      if (!result.coverPath || result.coverPath.startsWith("-")) throw new Error("--cover-path needs a path from the workspace root: --cover-path <path>");
    } else if (arg === "--records") {
      // `chant workspace box publish <member> --records` (#3165): the records kept uncommitted, not a work item.
      result.records = true;
    } else if (arg === "--expect") {
      // `chant workspace records amend|review|close <id> --expect <digest>` (#3173): the record's digest the caller last read.
      result.expect = args[++i];
      if (!result.expect || result.expect.startsWith("-")) throw new Error("--expect needs the record's digest, as records --json prints it: --expect <digest>");
    } else if (arg === "--label") {
      // `chant workspace wip save --label <text>` (#3172)
      result.label = args[++i];
      if (!result.label || result.label.startsWith("-")) throw new Error("--label needs the snapshot's name, such as a turn id: --label <text>");
    } else if (arg === "--branch") {
      // `chant workspace wip --branch <branch>` (#3172)
      result.branch = args[++i];
      if (!result.branch || result.branch.startsWith("-")) throw new Error("--branch needs a branch name: --branch <branch>");
    } else if (arg === "--security") {
      // `chant ci init --security <group>`, repeatable (#4168 step 6): a security group to turn on.
      const group = args[++i];
      if (!group || group.startsWith("-")) throw new Error("--security needs a group: --security verified-releases|supply-chain|who-ran-it|review-rules|isolated-runners");
      result.securityGroups = [...(result.securityGroups ?? []), group];
    } else if (arg === "--workflow") {
      // `chant ci workflow --workflow <name>`, repeatable (#3573)
      const name = args[++i];
      if (!name || name.startsWith("-")) throw new Error("--workflow needs a workflow's name: --workflow <name>");
      result.ciWorkflows = [...(result.ciWorkflows ?? []), name];
    } else if (arg === "--chant") {
      // `chant ci workflow --chant <command>` (#3573): what the tick step runs chant with.
      result.ciChant = args[++i];
      if (!result.ciChant || result.ciChant.startsWith("-")) throw new Error("--chant needs the command that runs chant, such as \"npx tsx packages/core/src/cli/main.ts\": --chant <command>");
    } else if (arg === "--commit") {
      // `chant ci run plan|apply --commit <sha>` (#4094): the commit the job runs at.
      result.commit = args[++i];
      if (!result.commit || result.commit.startsWith("-")) throw new Error("--commit needs the commit the job runs at: --commit <sha>");
    } else if (arg === "--pass-env") {
      // `chant ci run --pass-env <NAME>`, repeatable (#4094): a variable of the runner's environment the job gets.
      const name = args[++i];
      if (!name || name.startsWith("-")) throw new Error("--pass-env needs a variable's name, such as AWS_PROFILE: --pass-env <NAME>");
      (result.passEnv ??= []).push(name);
    } else if (arg === "--secrets") {
      // `chant ci run|serve --secrets <file>` (#4096): the host's secrets file, readable only by its owner.
      result.ciSecrets = args[++i];
      if (!result.ciSecrets || result.ciSecrets.startsWith("-")) throw new Error("--secrets needs the host's secrets file, a dotenv or JSON file only its owner can read: --secrets <file>");
    } else if (arg === "--repo") {
      // `chant ci serve --repo <owner/repo>` (#4095): the repository whose pull requests and target branch it polls.
      result.ciRepo = args[++i];
      if (!result.ciRepo || !/^[^/\s-][^/\s]*\/[^/\s]+$/.test(result.ciRepo)) throw new Error("--repo needs the repository as owner/name: --repo <owner/repo>");
    } else if (arg === "--run-index-limit") {
      // `chant ci run --run-index-limit <n>` (#4098): how many runs the index at the report URL keeps.
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error("--run-index-limit needs a whole number of runs, 1 or more: --run-index-limit <n>");
      result.runIndexLimit = n;
    } else if (arg === "--max-jobs") {
      // `chant ci serve --max-jobs <n>` (#4095): how many jobs run at once.
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error("--max-jobs needs a whole number of jobs, 1 or more: --max-jobs <n>");
      result.maxJobs = n;
    } else if (arg === "--author") {
      // `chant ci serve --author <login>`, repeatable (#4095): plan only pull requests these people opened.
      const login = args[++i];
      if (!login || login.startsWith("-")) throw new Error("--author needs a forge login: --author <login>");
      (result.ciAuthors ??= []).push(login);
    } else if (arg === "--rerun-failed") {
      // `chant ci serve --rerun-failed` (#4095): run again the failed apply at the target branch's head, and failed plans of open heads.
      result.rerunFailed = true;
    } else if (arg === "--install") {
      // `chant ci workflow --install <command>` (#3573): a step before the tick that installs what --chant runs.
      result.ciInstall = args[++i];
      if (!result.ciInstall || result.ciInstall.startsWith("-")) throw new Error("--install needs the install command, such as \"npm install\": --install <command>");
    } else if (arg === "--token-secret") {
      // `chant ci workflow --token-secret <NAME>` (#3573): the secret the tick's tag push authenticates with.
      result.ciTokenSecret = args[++i];
      if (!result.ciTokenSecret || result.ciTokenSecret.startsWith("-")) throw new Error("--token-secret needs a repository secret's name, such as CI_GREEN_TOKEN: --token-secret <NAME>");
    } else if (arg === "--app-id-var") {
      // `chant ci workflow --app-id-var <VAR> --app-key-secret <NAME>` (#3573): a GitHub App token pushes the tags.
      result.ciAppIdVar = args[++i];
      if (!result.ciAppIdVar || result.ciAppIdVar.startsWith("-")) throw new Error("--app-id-var needs the Actions variable holding the App's id: --app-id-var <VAR>");
    } else if (arg === "--app-key-secret") {
      result.ciAppKeySecret = args[++i];
      if (!result.ciAppKeySecret || result.ciAppKeySecret.startsWith("-")) throw new Error("--app-key-secret needs the secret holding the App's private key: --app-key-secret <NAME>");
    } else if (arg === "--runner-key-secret") {
      // `chant ci workflow --runner-key-secret <NAME>` (#4031): the secret holding the runner key the tick signs its tags with.
      result.ciRunnerKeySecret = args[++i];
      if (!result.ciRunnerKeySecret || result.ciRunnerKeySecret.startsWith("-")) throw new Error("--runner-key-secret needs the repository secret holding the runner key, such as CHANT_RUNNER_KEY: --runner-key-secret <NAME>");
    } else if (arg === "--verdict") {
      // `chant workspace records review <id> --verdict agree|dissent|abstain` (#2670)
      result.verdict = args[++i];
      if (!result.verdict || result.verdict.startsWith("-")) throw new Error("--verdict needs agree, dissent or abstain");
    } else if (arg === "--class") {
      // `chant workspace trust runner add <principal> --class runner|service` (#3510).
      result.runnerClass = args[++i];
      if (!result.runnerClass || result.runnerClass.startsWith("-")) throw new Error("--class needs runner or service: --class <class>");
    } else if (arg === "--by") {
      // `chant workspace records review <id> --by <principal>` (#2670): whoever the caller says.
      result.by = args[++i];
      if (!result.by || result.by.startsWith("-")) throw new Error("--by needs the reviewer: --by <principal>");
      // Repeatable for `workspace points answer` (#2739): each person who answered.
      (result.bys ??= []).push(result.by);
    } else if (arg === "--stale-notes") {
      // `chant build --pr-loop --stale-notes` (#4628).
      result.staleNotes = true;
    } else if (arg === "--stale") {
      // `chant components pr-post --stale` (#4628).
      result.stale = true;
    } else if (arg === "--tip") {
      // `chant components pr-post --tip <sha>` (#4628).
      const raw = args[++i];
      if (!raw || !/^[0-9a-f]{40}$/.test(raw)) throw new Error(`--tip needs the target branch's full commit sha: got "${raw ?? ""}"`);
      result.tip = raw;
    } else if (arg === "--open") {
      // `chant workspace points --open` (#2739): only the questions still open.
      result.open = true;
    } else if (arg === "--inputs") {
      // `chant workspace points ask <point> --inputs <file|-|json>` (#2739; JSON itself, #3403)
      result.inputs = args[++i];
      if (!result.inputs || (result.inputs.startsWith("-") && result.inputs !== "-")) throw new Error("--inputs needs a JSON file, - for standard input, or the JSON itself: --inputs <file|-|json>");
    } else if (arg === "--candidates") {
      // `chant workspace points ask <point> --candidates <file|-|json>` (#3403): an ad-hoc point's question and candidates.
      result.candidates = args[++i];
      if (!result.candidates || (result.candidates.startsWith("-") && result.candidates !== "-")) throw new Error("--candidates needs a JSON file, - for standard input, or the JSON itself: --candidates <file|-|json>");
    } else if (arg === "--response") {
      // `chant workspace points ask <point> --response <file>` (#2739): a POST /v1/systemone response the caller got.
      result.response = args[++i];
      if (!result.response || result.response.startsWith("-")) throw new Error("--response needs a JSON file: --response <file>");
    } else if (arg === "--subject") {
      // `chant workspace points ask <point> --subject <id>` (#2739): what the question is about.
      result.subject = args[++i];
      if (!result.subject || result.subject.startsWith("-")) throw new Error("--subject needs what the question is about, such as a work item id: --subject <id>");
    } else if (arg === "--store") {
      // `chant workspace points ask <point> --store ledger` (#3815): where a new question goes.
      const store = args[++i];
      if (store !== "tree" && store !== "ledger") throw new Error("--store is tree (the answer kind's directory in the working tree) or ledger (chant/lifecycle): --store <tree|ledger>");
      result.store = store;
    } else if (arg === "--answer") {
      // `chant workspace points answer <id> --answer <value>` (#2739)
      result.answer = args[++i];
      if (result.answer === undefined || result.answer === "") throw new Error("--answer needs one of the question's candidates: --answer <value>");
    } else if (arg === "--sign") {
      // `chant workspace records review <id> --sign [<key file>]` (#2687): seal the verdict.
      // `records new` and `records amend` take it too, to seal the record's author (#2688).
      // `chant approve <op> <gate> --sign [<key file>]` seals a gate approval (#3163).
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
    } else if (arg === "--key" || arg === "--check-id" || arg === "--claim" || arg === "--environment" || arg === "--envelope" || arg === "--threshold") {
      // `chant workspace evidence sign|verify` and `chant workspace signers` (#2553)
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) throw new Error(`${arg} needs a value`);
      const field = ({ "--key": "key", "--check-id": "checkId", "--claim": "claim", "--environment": "environment", "--envelope": "envelope", "--threshold": "threshold" } as const)[arg];
      result[field] = value;
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
    } else if (arg === "--release-plan") {
      result.releasePlanFile = args[++i];
    } else if (arg === "--release") {
      // `chant components promote --release <label|digest>` (#4026)
      result.release = args[++i];
      if (!result.release || result.release.startsWith("-")) throw new Error("--release needs a release's label or digest: --release <label|digest>");
    } else if (arg === "--build") {
      // `chant release cut --build <command>` (#4026)
      result.buildCommand = args[++i];
      if (!result.buildCommand) throw new Error("--build needs a shell command: --build '<command>'");
    } else if (arg === "--artifacts") {
      // `chant release compile --artifacts` (#4026, internal)
      result.artifacts = true;
    } else if (arg === "--git-sha") {
      result.gitSha = args[++i];
    } else if (arg === "--run-id") {
      result.runId = args[++i];
    } else if (arg === "--actor") {
      result.actor = args[++i];
    } else if (arg === "--approver") {
      result.approver = args[++i];
    } else if (arg === "--statement") {
      // `chant approve <op> <gate> --statement` (#4646): print the bytes an approval signs, for a signature made elsewhere.
      result.statement = true;
    } else if (arg === "--signature") {
      // `chant approve <op> <gate> --signature <file|-> --at <timestamp>` (#4646): an approval signed elsewhere.
      result.signature = args[++i];
      if (!result.signature || (result.signature.startsWith("-") && result.signature !== "-")) {
        throw new Error("--signature needs a file holding the signature, or - for stdin: --signature <file|->");
      }
    } else if (arg === "--relayed-by") {
      // `chant approve <op> <gate> --relayed-by <principal>` and `workspace points answer <id> --relayed-by <principal>` (#3402):
      // who carried the approval or answer to chant for the person it names.
      result.relayedBy = args[++i];
      if (!result.relayedBy || result.relayedBy.startsWith("-")) throw new Error("--relayed-by needs the principal that relayed it: --relayed-by <principal>");
    } else if (arg === "--on") {
      // `chant run ... --on <lexicon>` (#2121) — which runtime hosts the run.
      result.on = args[++i];
      if (!result.on || result.on.startsWith("-")) throw new Error("--on needs a runtime name: --on <lexicon>");
    } else if (arg === "--compare-to") {
      result.compareTo = args[++i];
    } else if (arg === "--no-release-record") {
      result.noReleaseRecord = true;
    } else if (arg === "--no-record") {
      // `chant run <op|--components> --no-record` (#3955): write nothing to chant/lifecycle and push nothing.
      result.noRecord = true;
    } else if (arg === "--fold") {
      result.fold = true;
    } else if (arg === "--no-cache") {
      // `chant workspace graph --no-cache` (#2876): read every member.
      result.noCache = true;
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
    } else if (arg === "--lexicon-output") {
      // `--lexicon-output <lexicon>=<path>` (repeatable); the joined form
      // `--lexicon-output=otel=a.yml` arrives here already split at the first `=`.
      (result.lexiconOutput ??= []).push(args[++i]);
    } else if (arg === "--params-file") {
      result.paramsFile = args[++i];
    } else if (arg === "--projection") {
      result.projection = args[++i];
    } else if (arg === "--interval") {
      result.interval = args[++i];
    } else if (arg === "--lease-ttl") {
      result.leaseTtl = args[++i];
    } else if (arg === "--steward") {
      // #2731 — the name is optional: a project with one steward runs it
      // with a bare `--steward`.
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        result.steward = next;
        i++;
      } else {
        result.steward = "";
      }
    } else if (arg === "--once") {
      result.once = true;
    } else if (arg === "--setup-key") {
      // `chant ci serve|run --setup-key` (#4099): make the host's runner key and print its public half.
      result.setupKey = true;
    } else if (arg === "--trust") {
      // `chant ci serve|run --setup-key --trust` (#4099): list the key in .chant/trust.json on a branch.
      result.trustKey = true;
    } else if (arg === "--in-place") {
      // `chant ci run --in-place` (#4156): run the job in this checkout, as a generated forge job does.
      result.ciInPlace = true;
    } else if (arg === "--require-runner-start") {
      // `chant ci run --require-runner-start` (#4147): refuse the job unless a provisioner's runner-start statement names it.
      result.requireRunnerStart = true;
    } else if (arg === "--job") {
      // `chant ci runner-start sign --job <json|@file>` (#4147): the CI job a runner was started for.
      result.ciJob = args[++i];
      if (!result.ciJob || result.ciJob.startsWith("-")) throw new Error("--job needs the job as JSON or @<file>: --job @job.json");
    } else if (arg === "--no-push") {
      // `chant ci run --no-push` (#4156): keep the run record on the local chant/lifecycle.
      result.noPush = true;
    } else if (arg === "--no-require-review") {
      // `chant ci run apply --no-require-review` (#4156): the apply without pr-apply's --require-review, the default since #4168.
      result.requireReview = false;
    } else if (arg === "--unsigned") {
      // `chant ci serve --unsigned` (#4099): serve without a runner key listed at the target's head.
      result.unsigned = true;
    } else if (arg === "--principal") {
      // `chant ci serve|run --setup-key --trust --principal <name>` (#4099): the runner's principal.
      result.ciPrincipal = args[++i];
      if (!result.ciPrincipal || result.ciPrincipal.startsWith("-")) throw new Error("--principal needs the runner's principal: --principal <name>");
    } else if (arg === "--work") {
      // `chant run <op> --work <id>` (#2748)
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("--work needs a work item id: --work <id>");
      result.work = value;
      (result.works ??= []).push(value);
    } else if (arg === "--holder" || arg === "--ttl" || arg === "--token" || arg === "--outcome") {
      // `chant workspace work claim|renew|release <id>` (#2732)
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error(`${arg} needs a value: ${arg} <${arg.slice(2)}>`);
      result[arg.slice(2) as "holder" | "ttl" | "token" | "outcome"] = value;
    } else if (arg === "--input" || arg === "--org" || arg === "--endpoint") {
      // `chant workspace init --from tfc|spacelift` (#3178): an exported file instead of the API, the Terraform Cloud organization, the Spacelift GraphQL endpoint.
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error(`${arg} needs a value: ${arg} <${arg === "--input" ? "file" : arg.slice(2)}>`);
      result[arg.slice(2) as "input" | "org" | "endpoint"] = value;
    } else if (arg === "--signer") {
      // `chant workspace runs statement <id> --signer <principal>` (#3192): the runner principal that will sign.
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("--signer needs a principal: --signer <principal>");
      result.signer = value;
    } else if (arg === "--unit" || arg === "--decision") {
      // `chant workspace runs --unit <id> | --decision <id>` (#3033): the runs on one work item, or for one decision.
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error(`${arg} needs an id: ${arg} <id>`);
      result[arg.slice(2) as "unit" | "decision"] = value;
    } else if (arg === "--note") {
      result.note = args[++i];
    } else if (arg === "--reason") {
      // `chant approve policy-override <subject> --reason <text>` (#3760): why the denied plan goes out anyway.
      result.reason = args[++i];
      if (result.reason === undefined || result.reason.startsWith("-")) throw new Error("--reason needs the text of the reason: --reason <text>");
    } else if (arg === "--rule") {
      // `chant approve policy-override <subject> --rule <id>` (#3760), once per rule that denied the plan.
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("--rule needs a rule id: --rule <id>");
      (result.rules ??= []).push(value);
    } else if (arg === "--expire") {
      result.expire = true;
    } else if (arg === "--role") {
      // #2508 — a role the approver claims, recorded on the approval. A quorum
      // (#4290) and a gate policy (#4324) read roles from .chant/trust.json at base.
      // Repeatable, and a comma list works too.
      const value = args[++i] ?? "";
      result.roles = [...(result.roles ?? []), ...value.split(",").map((r) => r.trim()).filter(Boolean)];
    } else if (arg === "--agent") {
      // #2508 — record the approval as an agent's rather than a person's.
      result.agent = true;
    } else if (arg === "--allow-code") {
      // #2550 — `chant workspace upgrade` runs a template's code migrations
      // only when asked to.
      result.allowCode = true;
    } else if (arg === "--allow-skip") {
      // #4030 — `chant components promote` skips a step of the member's
      // declared promotion order only when asked to.
      result.allowSkip = true;
    } else if (arg === "--source") {
      // #2551 — `chant workspace upgrade --source <repo>[#<member>]`.
      result.source = args[++i];
      // #4044: also `chant ci tick|list --source checks|runs`.
      if (!result.source || result.source.startsWith("-")) throw new Error("--source needs a template: --source <repo>[#<member>] for workspace upgrade, or a source for ci tick and ci list: --source checks|runs");
    } else if (arg === "--tags") {
      // #2551 — `chant workspace adopt-lineage --tags <glob>`, also hash-index and versions.
      result.tags = args[++i];
      if (!result.tags || result.tags.startsWith("-")) throw new Error("--tags needs a tag glob: --tags 'v*'");
    } else if (arg === "--index") {
      // #2551 — `chant workspace adopt-lineage --index <file>`; #4525 — `chant search --index <ref>`;
      // #4526 — `chant lifecycle diff <env> --index <ref>`.
      result.index = args[++i];
      if (!result.index || result.index.startsWith("-")) throw new Error("--index needs a value: --index <file> for workspace adopt-lineage, --index <scope key>[@<version>] for search and lifecycle diff");
    } else if (arg === "--adopt") {
      // #4537 — `chant run --components <name> --env <env> --adopt <file>`: adopt the adoption file's resources into the component's stack.
      result.adopt = args[++i];
      if (!result.adopt || result.adopt.startsWith("-")) throw new Error("--adopt needs an adoption file: --adopt <file>");
    } else if (arg === "--adopt-out") {
      // #4536 — `chant import --index <ref> --adopt-out <file>`: write the adoption file (`adopt: v1`) for what was imported.
      result.adoptOut = args[++i];
      if (!result.adoptOut || result.adoptOut.startsWith("-")) throw new Error("--adopt-out needs a file: --adopt-out <file>");
    } else if (arg === "--remove") {
      // #2552 — `chant workspace import --remove` removes the export member instead of writing it again.
      result.remove = true;
    } else if (arg === "--available") {
      // #2551 — `chant workspace versions --available` lists the template's version tags.
      result.available = true;
    } else if (arg === "--root-only") {
      // #2537 — `chant build` and `chant lint` at a declared workspace root
      // run on the root project alone instead of refusing with WSP000.
      result.rootOnly = true;
    } else if (arg === "--forge-repos") {
      // #3168 — `chant workspace check --forge-repos <file>`: the forge's
      // repository list, as a warden reads it, for an org workspace's checks.
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("--forge-repos needs a file: --forge-repos <repos.json>");
      result.forgeRepos = value;
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
    } else if (arg === "--where") {
      // #4363 — a typed filter on a contract read; repeatable, every clause has to hold.
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("--where needs a clause: --where <field><op><value>");
      result.where = [...(result.where ?? []), value];
    } else if (arg === "--read") {
      // behold#995 - `chant workspace drift --read <read>`: which read the member's engine answers with.
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("--read needs a read: --read <state|plan|refresh|live-read|ownership>");
      result.driftRead = value;
    } else if (arg === "--stream") {
      result.stream = true;
    } else if (arg === "--resource") {
      // behold#995 - `chant workspace drift --resource <addr>`: one resource's drift.
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("--resource needs an address: --resource <addr>");
      result.resource = value;
    } else if (arg === "--since") {
      result.since = args[++i];
    } else if (arg === "--wait") {
      // `chant ci verdict --wait` (#4644): read the check runs again until no required phase is pending.
      result.ciWait = true;
    } else if (arg === "--lane") {
      // `chant ci last-green --lane <name>` and `chant ci base --lane <name>` (#4662): a green lane's tags and phases.
      result.lane = args[++i];
    } else if (arg === "--phase") {
      // `chant ci base --phase <name>` (#4643): the ci.green phase whose base to find.
      result.phase = args[++i];
    } else if (arg === "--audit-log") {
      // `chant audit-log attribute|unrecorded --audit-log aws[:<region>]` (#4632).
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("--audit-log needs the log: --audit-log aws[:<region>]");
      result.auditLog = value;
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
    } else if (/^-[A-Za-z]/.test(arg)) {
      // chant #4369 — an unrecognised short flag (`-x`) is refused like an
      // unrecognised `--flag` (#1127). It used to be dropped without a word,
      // the same silent misparse #1127 closed for long flags. A lexicon's own
      // mounted command still gets its short flags: `main` tries the plugin
      // commands before rethrowing a parse error.
      throw new Error(`Unknown flag: ${arg}\nRun "chant --help" to see supported flags.`);
    } else {
      // Anything else is a positional, including a token that starts with `-`
      // but is not flag-shaped (#4369): `->kind:Bucket` is a search query that
      // opens with an outgoing edge term, and dropping it made `chant search`
      // answer for "." instead. A bare `-` is a positional too.
      positional(arg);
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
