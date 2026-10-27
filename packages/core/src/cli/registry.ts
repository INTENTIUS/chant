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
  /** Every positional after the command word, in order (#3308): for a command with more than three, such as `workspace box listing set <member>`. */
  positionals?: string[];
  output?: string;
  format: string;
  force?: boolean;
  fix: boolean;
  lexicon?: string;
  template?: string;
  watch: boolean;
  verbose: boolean;
  help: boolean;
  /** `--version` / `-V` (#2701): print the installed chant's version. */
  version?: boolean;
  report?: boolean;
  /** `chant run` — force the local in-process executor (the default). `chant ci run --local` (#4161): run the job on this machine with no push, status or report upload. */
  local?: boolean;
  /**
   * `chant run <op> --on <lexicon>` (#2121) — which runtime hosts the run.
   * The named lexicon's `opRuntime` (`../lexicon.ts`) takes it; omitted, core's
   * built-in `local` provider does. Applies to every `run` subcommand, so
   * `run status`/`log`/`list`/`cancel`/`approve` all address the same runtime
   * the run started on.
   */
  on?: string;
  /**
   * `-p, --profile <name>` (#2124, restored in #2192) — which named connection
   * profile the hosting runtime targets, handed to it as
   * {@link OpRunStartOptions.profile}. Only a runtime that declares profiles
   * reads it: fountain resolves it through `fountain.profiles` in
   * `chant.config.ts` and refuses a name it does not find. Omitted, each
   * runtime keeps its own default (fountain's `defaultProfile`).
   */
  profile?: string;
  /** `chant run` — emit the structured OpRunResult as JSON on stdout. */
  json?: boolean;
  /**
   * `chant run <op> --gated-exit <code>` (#2243) — the process exit code a
   * run that stopped at an unapproved gate returns, instead of the default 3.
   *
   * Only the gated outcome is remapped. A run that fails still returns 1 and a
   * run that completes still returns 0, so `--gated-exit 0` on a CI job means
   * "a pending approval is not a broken build" and nothing more. The `--json`
   * payload is untouched by it: the record still says `status: "gated"` and
   * still carries the gate and the `chant approve` line, so a job that maps the
   * code to success can still tell the two apart.
   *
   * Accepts 0-255 (a POSIX exit status). Anything else is refused by name.
   */
  gatedExit?: number;
  /**
   * `chant run --components <name|all> --progress-json` (local executor) —
   * stream one NDJSON `RunProgressEvent` (../../components/run-progress.ts)
   * per line to stdout while the run executes, so a consumer can render live
   * wave/component/phase/step progress instead of tailing raw logs.
   *
   * `chant run <name> --progress-json` streams one NDJSON `StepRecord`
   * (../../op/local-executor.ts) per settled step instead, fed by whatever
   * the resolved runtime reports through its `progress` hook (#2121).
   *
   * Both are purely additive: run semantics, ordering, and exit code are
   * unchanged; omitted (undefined, not false) when the flag isn't passed.
   */
  progressJson?: boolean;
  /**
   * `--events-json` (#4041) — stream the run's events to stdout, one
   * `run-event.schema.json` line each (`../../run-event.ts`), on `chant run
   * <op>`, `chant run --components`, `components promote|rollback|redeploy`,
   * `components fan-out` and `components pr-plan|pr-apply`. Refused beside
   * `--progress-json`, which prints the older shapes to the same stdout.
   */
  eventsJson?: boolean;
  /** `chant run events <run> --follow` (#4042) — stream the run's events as they happen, until `run-settle`. */
  follow?: boolean;
  live: boolean;
  /** `chant migrate --from <name>` (default "github"); `lexicon/dialect` for the sql lexicon */
  migrateFrom?: string;
  /** `chant import --kustomize <dir>` — render the kustomization, then import (#1548) */
  kustomize?: string;
  /** `chant import --parser-option key[=value]`, repeatable (#2994): options for the lexicon's template parser */
  parserOption?: string[];
  /** `chant carve advise --state <path>` — opt-in .tfstate for accurate instance counts */
  statePath?: string;
  /** Every `--state` value in order (#4461): `chant workspace promote --all --state <member>=<path>`, repeatable. */
  statePaths?: string[];
  /** `chant workspace promote --all --state-dir <dir>` (#4461): a member's state is `<dir>/<member>.tfstate`. */
  stateDir?: string;
  /** `chant workspace promote --all --wave-size <n>` (#4461): roots per wave after the canary. */
  waveSize?: number;
  /** `chant workspace promote --all` (#4461): promote every terraform member, in waves. */
  all?: boolean;
  /** `chant carve emit --select <tf-address>` — the Terraform resource to carve */
  selectAddress?: string;
  /** `chant carve emit --live-name <logicalId>` — CFN logical ID for live adoption */
  liveName?: string;
  /** `chant carve bridge --apply-rewrites` — write rewritten survivor .tf in place */
  applyRewrites?: boolean;
  /** `chant carve apply --stack <name>` — ownership-marker stack for graduation */
  carveStack?: string;
  /** `chant carve apply --write` — save the graduation doc */
  write?: boolean;
  /** `chant carve apply --write-source` — stamp the ownership marker into the emitted source */
  writeSource?: boolean;
  /** `chant migrate --to <name>` (default "gitlab"); `lexicon/dialect` for the sql lexicon */
  migrateTo?: string;
  /** `chant migrate --emit yaml|ts|sql` */
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
  /**
   * `chant init --skip-mcp` (#2383) — scaffold without writing the project's
   * `.mcp.json`. The option existed on `InitOptions` and was documented long
   * before anything parsed it, so there was no way to decline the write.
   */
  skipMcp?: boolean;
  /** `chant import --type <ResourceType>` selector */
  selectType?: string;
  /** `chant import --name <name>` selector */
  selectName?: string;
  /** `chant import --index <ref> --tag key=value` (#4524), repeatable */
  selectTags?: string[];
  /** `chant import --owned` — restrict live import to chant-owned resources */
  owned?: boolean;
  /**
   * `chant graph --live --namespace <ns>` / `chant lifecycle diff <env> --live
   * --namespace <ns>` / `chant lifecycle plan <env> --namespace <ns>` (#1629) —
   * where to READ an entity whose declaration names no namespace of its own.
   *
   * A GitOps estate splits the binding from the objects: the control-plane
   * project declares `spec.targetNamespace`, the app project declares bare
   * objects the controller stamps at apply time. Without this the app
   * project's live read falls through to the substrate default and paints a
   * running estate as absent.
   *
   * A default, never a rewrite — an entity that declares its own namespace is
   * read from the one it declares. Lexicons with no namespace-like scope
   * ignore it.
   */
  namespace?: string;
  /** `chant workspace upgrade --allow-code` (#2550) — run migrations whose body is the template's own code. */
  allowCode?: boolean;
  /** `chant components promote --allow-skip` (#4030): promote past a step of the member's declared promotion order. */
  allowSkip?: boolean;
  /** `chant release publish --allow-unsigned` (#4049): publish a release with no signature that verifies, with a warning. Never overrides identity.gates.release. */
  allowUnsigned?: boolean;
  /** `chant release publish --require-provenance` (#4049): refuse a run with no OIDC token, where it warns. */
  requireProvenance?: boolean;
  /** `chant workspace upgrade --source <repo>[#<member>]` (#2551): move the scope to another template. */
  source?: string;
  /** `chant workspace adopt-lineage --tags <glob>` and `hash-index --tags` (#2551): the tags to compare. */
  tags?: string;
  /** `chant workspace adopt-lineage --index <file>` (#2551): a cached hash index. `chant search --index <ref>` (#4525) and `chant lifecycle diff <env> --index <ref>` (#4526): an index version. */
  index?: string;
  /** `chant workspace versions --available` (#2551): list each git template's version tags. */
  available?: boolean;
  /** `chant workspace import --remove` (#2552): remove the export member instead of writing it again. */
  remove?: boolean;
  /** `chant lifecycle rollback --dry-run` — compute the rollback delta and print it; open no PR, push nothing, leave no branch. */
  dryRun?: boolean;
  /** `chant workspace exit --drill` (#3177): run the exit on a scratch copy and check it, changing nothing. */
  drill?: boolean;
  /** `chant lifecycle teardown <env> --yes` — execute the planned deletion
   * (#1222). Without it the command plans and stops. */
  yes?: boolean;
  /** `chant lifecycle gc --yes --push` (#4036): push the commit the prune wrote to chant/lifecycle. Without it the prune stays local. */
  push?: boolean;
  /** `chant lifecycle teardown <env> --yes --confirm-prod` — the non-interactive
   * form of the extra confirmation a production-like environment name demands
   * (#1222). Meaningless without `--yes`. */
  confirmProd?: boolean;
  /** `chant import --verbatim` — keep server-defaulted fields in live import */
  verbatim?: boolean;
  /** `chant import --skip-undeclarable` — import what can be declared and warn about the live objects that cannot, instead of failing */
  skipUndeclarable?: boolean;
  /** `chant lifecycle … --src <dir>` — build root override for lifecycle commands. Also `chant release cut --src <dir>` (#4046): the build root of a project with no components. */
  src?: string;
  /** `--env <name>` — active environment: sets CHANT_ENV so env-aware source
   * re-evaluates for that environment (`build` + `graph`), and drives policy. */
  env?: string;
  /** `chant emulator up --port <container-port>=<host-port>`, repeatable (#3673); a bare `<host-port>` when one emulator is selected. */
  port?: string[];
  /**
   * `chant emulator up --image <ref>` (#3952): the image to start, when one
   * emulator is selected. `chant build --components --generate --image <ref>`
   * (#4002): the image every generated job runs in.
   */
  image?: string;
  /** `chant build --components --generate --before-script <line>`, repeatable (#4002): shell lines every generated job runs before its command. */
  beforeScript?: string[];
  /** `chant emulator up --network <name>` (#3952): the Docker network each started container joins. */
  network?: string;
  /** `chant emulator up --setting <KEY>=<VALUE>`, repeatable (#3952): an emulator setting such as `FLOCI_<NAME>`, passed as `-e`. */
  setting?: string[];
  /** `chant emulator up --loopback` (#3952): publish ports on 127.0.0.1 only. */
  loopback?: boolean;
  /** `chant build --components --generate <lexicon> --promote-to <env>` (#2575) — add a promote job to the generated pipeline. */
  promoteTo?: string;
  /** `chant graph --stacks` — render the cross-stack apply-ordering graph */
  stacks?: boolean;
  /** `chant graph --live --overlay` — classify the provisioned graph against
   * declared source: managed / foreign / pending (#780). */
  overlay?: boolean;
  /** `chant lifecycle diff <env> --between <refA> <refB>` (#822) — diff two saved
   * snapshots (orphan-branch commits from `lifecycle log`) against each other. */
  betweenA?: string;
  betweenB?: string;
  /** `chant graph --live --overlay --overlay-anchor <source|live>` (#821) — which
   * graph is the canvas. `source` (default) keeps the declared edges (the
   * cross-substrate topology) and joins live status per node; `live` keeps the
   * provisioned graph's reconstructed edges (the pre-#821 behaviour). */
  overlayAnchor?: "source" | "live";
  /** `chant graph --live --overlay --traffic "<level>"` (#2377) — predict the
   * overlaid estate's behaviour at this traffic level and carry the result on
   * the IR: each entity's block on `attrs._behaviour`, the report's meta (or a
   * whole refusal report) on `meta._behaviour`.
   *
   * The flag is the trigger, and it has no default. The level is passed to the
   * engine verbatim — chant does not parse it, default it or convert it
   * (`../behaviour.ts`) — so without the flag there is no traffic level to
   * predict *at*, nothing is asked, and neither key appears. A consumer reads
   * that absence as "not looked", never as a refusal. */
  traffic?: string;
  /** `chant list --components` / `chant graph --components` — surface discovered
   * `Component` declarations (#560) instead of/alongside lexicon resources. */
  components?: boolean;
  /** `chant build --components --generate <lexicon>` — generate mode (#563):
   * synthesize CI YAML from discovered components instead of running a normal
   * lexicon build. Also `chant run --generate <provider>` (#2533): one CI
   * pipeline file per scheduled Op, through `generateOpsPipeline`. */
  generate?: string;
  /** `chant run --generate <provider> --spec <file>` (#2533): a JSON file of
   * `ScheduledOpSpec`s (or `{ ops, options }`) to generate instead of every
   * discovered Op that declares a `schedule`. */
  opsSpec?: string;
  /** `chant graph --format ir --detail <0..3>` — graph IR detail tier */
  detail?: number;
  /** `chant graph --lens <kind>:<target>` — focus the graph IR on a slice */
  lens?: string;
  /** `chant search --show a,b` — extra attributes to include per matched row (#1139). */
  show?: string;
  /** `chant search --explain` — append a footer: universe count + why non-matches were excluded (#1139). */
  explain?: boolean;
  /** `chant search --count-by kind|module|attr:<name>`: print one count per group instead of one row per match (#4360). */
  countBy?: string;
  /** `chant graph --lens blast:<node> --up` — include upstream producers */
  up?: boolean;
  /** `chant graph --lens blast:<node> --down` — include downstream dependents */
  down?: boolean;
  /** `chant graph --format layout --node-sizes <json|-|@file>` — painter-measured
   * node footprints `{id:{w,h}}` so the layout spaces for real card sizes (#509). */
  nodeSizes?: string;
  /** `chant graph --format layout --layout-engine dagre|graphviz` (default dagre). */
  layoutEngine?: string;
  /** `chant lifecycle affected --base <ref>` — base git ref to diff against */
  base?: string;
  /** `chant lifecycle affected --head <ref>` — head git ref (default: working tree) */
  head?: string;
  /** `chant lifecycle affected --include-dependents` — add downstream consumers */
  includeDependents?: boolean;
  /** `chant workspace run --dependents-of <member> --op <op>` (#2554): run the Op in every member that links to this one, directly or not. */
  dependentsOf?: string;
  /** `chant workspace lint --cross-root` (#2549): also run the disagreement lint and the lexicons' cross-root checks over every member's graph. */
  crossRoot?: boolean;
  /** `chant workspace train <env> --pin <member>=<label|digest>` (#2554), repeatable: the release a train pins for that member instead of its newest. */
  pins?: string[];
  /**
   * `chant components fan-out --from-affected <file>` (#2420) — read the
   * stack-level change signal from the JSON `chant lifecycle affected --json`
   * wrote, instead of re-deriving it with `--base`. The composable half of the
   * pair: a CI job that already ran the diff has no reason to build twice.
   */
  fromAffected?: string;
  /**
   * `chant components fan-out --gate <name>` (#2420) — the name of the single
   * gate over the whole derived set, answered by `chant approve fan-out <name>
   * --plan <digest>`. One approval covers the fan-out, bound to the plan's
   * digest (#2300's mechanism, #2417's decision); omitted, the fan-out runs
   * ungated. A component's own authored gates are unaffected either way.
   */
  gate?: string;
  /**
   * `chant components fan-out --wave-gate <name>` (#3049) — one gate per wave
   * instead of one over the set. Wave `n` waits on `<name>-wave-<n>`, bound to
   * that wave's set digest, and is planned only once the waves before it
   * applied. Also `chant build --components --generate <lexicon> --wave-gate
   * <name>`, which generates one CI job per wave.
   */
  waveGate?: string;
  /** `chant components fan-out --wave <n>` (#3049) — run wave `n` of a `--wave-gate` fan-out and no other. Also `chant run wave --wave <k>` (#3679). */
  wave?: number;
  /** `chant run wave --decide` (#3679) — plan a wide wave and decide its gate, applying nothing. */
  decide?: boolean;
  /** `chant run wave --record-plans` (#3684) — plan every wave at a pull request's head and record the digests for a `pr-review` gate. */
  recordPlans?: boolean;
  /** `chant run wave --share <i>` (#3679) — apply share `i` of a decided wide wave. */
  share?: number;
  /** `chant run wave --group <name>` (#3914) — apply one job group's runs of a decided wave. */
  group?: string;
  /**
   * `chant components fan-out --target <component>:<address>` and `chant run
   * --components --target ...` (#4300), repeatable: the addresses a
   * component's steps narrow to. Raw values; `parseComponentTargets` groups them.
   */
  targets?: string[];
  /** `chant components fan-out --canary <component>` (#3049), repeatable — components that form wave 1. */
  canary?: string[];
  /**
   * `chant components pr-plan|pr-apply --pr <n>` (#3183) — the pull or merge
   * request the plan belongs to. Its gate is recorded under op `pr-<n>`.
   * pr-apply finds it from the commit through `--forge` when omitted.
   */
  pr?: number;
  /** `chant lock --list` (#4293): print the target locks instead of taking any. */
  list?: boolean;
  /** `chant lock --stage plan|apply|lock` (#4293): how the lock is taken. Default `lock`. */
  lockStage?: string;
  /** `chant lock --from-report <file>` (#4293): lock the components a `pr-plan.json` lists. */
  fromReport?: string;
  /** Every `--pr <n>`, in order: `chant release compose` (#4168 4.3) takes several. */
  prs?: number[];
  /** `chant release cut --channel <tag>` (#4168 4.3): the tag a publish of the release moves in place of `latest`. */
  channel?: string;
  /**
   * `chant components pr-plan|pr-apply --forge github|gitlab|forgejo` (#3183)
   * — post the note and the commit status on this forge, with the client
   * read from the CI job's environment.
   */
  forge?: string;
  /**
   * `chant components pr-apply --require-review` (#3183) — count an approval
   * only when its approver has a standing approving review on the pull
   * request. Needs `--forge`. `chant ci run apply --require-review`
   * passes it on, and `chant build --pr-loop --require-review` generates a
   * pipeline that does (#4168); `--no-require-review` (#4156) sets it false,
   * which is the default.
   */
  requireReview?: boolean;
  /**
   * `chant components pr-plan|pr-apply --report-url <url>` (#4007) — copy
   * the stage's report, change set and run events to `<url>/<pr>/<commit>/`,
   * an `s3://` or `file://` URL, the events as each wave and component settles.
   */
  reportUrl?: string;
  /**
   * `chant build --components --generate <lexicon> --pr-loop` (#3183) —
   * generate the pull-request pipeline: plan on the pull request, and on
   * merge record the plan (#4168), or apply it with `--apply-on-merge`.
   */
  prLoop?: boolean;
  /**
   * `chant build --pr-loop --apply-on-merge` and `chant ci serve
   * --apply-on-merge` (#4168): on merge apply the approved plan, as before
   * #4168, in place of recording it. Opt-in: a merge deploys nothing without it.
   */
  applyOnMerge?: boolean;
  /**
   * `chant components pr-apply --green` (#4168 step 9): apply the green commit
   * at HEAD, measured from the one last applied to the environment, under the
   * approved plans of the merges between or a gate of its own.
   */
  green?: boolean;
  /** `chant build --pr-loop --pr-env` (#4298) — add the env-up, env-down and env-sweep jobs of a pull request's environment. */
  prEnv?: boolean;
  /**
   * `chant components pr-apply --before-merge` (#4301, ws-106): apply an open
   * pull request's plan from its head, once the declaration at base sets
   * `ci.workflow: "apply-before-merge"` and the pull request is approved,
   * mergeable, undiverged and green.
   */
  beforeMerge?: boolean;
  /**
   * `chant build --pr-loop --apply-before-merge` and `chant ci run apply
   * --apply-before-merge` (#4301): the pipeline's apply job applies an open
   * pull request before it merges, and a merge records.
   */
  applyBeforeMerge?: boolean;
  /** `chant build --pr-loop --pr-build` (#4088) — build and lint before pr-plan and pr-apply. */
  prBuild?: boolean;
  /** `chant ci serve --build-command <line>` (#4169) — the line that builds a commit a `ci/build/<sha>` tag asks for, in a worktree of it. */
  ciBuildCommand?: string;
  /** `chant ci serve --land` (#4168 4.4) — fast-forward the target branch to each pushed `chant/land/<name>` branch whose `ci.green.preMerge` phases pass on it. */
  ciLand?: boolean;
  /** `chant build --pr-loop --pr-build-command <line>` (#4088) — the build line to run in place of `chant build --env <env>`. */
  prBuildCommand?: string;
  /**
   * `chant components fan-out --resume <file>` (#2420) — the attempt record
   * this fan-out reads before it starts and writes when it finishes. Repeating
   * the identical command finishes what an interrupted attempt left, because
   * the plan is narrowed by this file before the gate is decided and the
   * digest is carried rather than recomputed, so the approval still stands.
   * `chant components pr-apply --resume <file>` (#3464) keeps the same record
   * with the approved change set in it, and finishes an apply that failed
   * partway under that approval.
   */
  resume?: string;
  /**
   * `chant approve <op> <gate> --resume` (#3683): after recording the
   * approval, start the CI job that waits at the gate again through the
   * forge's API. Set when `--resume` is given no value.
   */
  resumeRun?: boolean;
  /** `chant audit --tier merge-worthy|all` */
  tier?: string;
  /**
   * `chant audit --agents` / `chant import --agents` — switch the subject from
   * a repo's pipeline YAML to the agent configuration installed on this
   * machine (skills, MCP servers, instruction files, permissions).
   */
  agents?: boolean;
  /** `--agents --scope system,user,project` — which scopes to scan (default all). */
  scope?: string;
  /** `--agents --runtime claude,codex,...` — which agent harnesses to scan (default all). */
  runtime?: string;
  /**
   * `--agents --all-projects` — scan every project root the harness has
   * registered in `~/.claude.json`, not just the path argument.
   */
  allProjects?: boolean;
  /** `chant audit --fail-on merge-worthy|warning|error|none` */
  failOn?: string;
  /** `chant audit --max-files <n>` (#2528) — files the local walk takes before it stops (default 1000). */
  maxFiles?: number;
  /** `chant audit --theme <file>` — JSON theme knobs for the HTML report */
  theme?: string;
  /** `chant dev surface-diff --update-snapshot` — write the fresh snapshot as the new baseline */
  updateSnapshot?: boolean;
  /**
   * `chant lifecycle diff <env> --live --update-baseline` (#1014) — record every
   * property-level deviation this run reports as *accepted*, so it stops
   * re-alerting. Value-bound: a later change to the accepted value is drift
   * again. Writes `<env>/observation-baseline.json` on the chant/lifecycle
   * orphan branch; never touches the cloud.
   */
  updateBaseline?: boolean;
  /**
   * `chant lifecycle snapshot <env> --deep` (#1267) — also record each
   * resource's normalized property tree, not just its identity. What a fold
   * over topology needs, and what a snapshot-backed query needs to answer a
   * property question at all. Costs more provider calls and a larger record,
   * so it is opt-in.
   */
  deep?: boolean;
  /**
   * `chant search "<q>" --at <ref> --env <name>` (#1266) — answer from a
   * recorded observation instead of reading the estate now. `latest` uses the
   * most recent snapshot. Mutually exclusive with `--live`: they are two
   * different observations of the same estate, and there is no rule for which
   * should win.
   */
  at?: string;
  /**
   * `chant search "<q>" --snapshot <ref> --env <name>` and `chant workspace
   * search "<q>" --snapshot <ref>` (#4374): the recorded snapshot to answer
   * from. Plain search also takes it as `--at <ref>`, for compatibility;
   * everywhere else in the read contract `--at` is a git revision.
   */
  snapshot?: string;
  /**
   * `chant search --capabilities` and `chant workspace search --capabilities`
   * (#4375): print the capability catalog, the `capabilities` document of the
   * read contract, instead of answering a query.
   */
  capabilities?: boolean;
  /**
   * `chant graph --format ir --capability-view` (#4378): add the lexicon-neutral
   * view capability rules read, mapped by this chant's lexicons, to the IR as
   * `capabilityView`. `chant workspace graph --capability-view` asks each
   * member's chant for it and carries it on the member.
   */
  capabilityView?: boolean;
  /** `chant workspace records --kind <path>` (#2546): the record kind file to read records through. */
  kind?: string;
  /** Every `--kind` given, in order: `chant workspace graph --intent` reads each (#2651). */
  kinds?: string[];
  /** Every `--by` given, in order: `chant workspace points answer` counts each person toward the quorum (#2739). */
  bys?: string[];
  /** `chant workspace points --open` (#2739): only the questions still open. */
  open?: boolean;
  /** `chant workspace points ask <point> --inputs <file|-|json>` (#2739): the inputs, as a JSON object. */
  inputs?: string;
  /** `chant workspace points ask <point> --candidates <file|-|json>` (#3403): an ad-hoc point's question and candidates. */
  candidates?: string;
  /** `chant workspace points ask <point> --response <file>` (#2739): a POST /v1/systemone response the caller got from a backend. */
  response?: string;
  /** `chant workspace points ask <point> --subject <id>` (#2739): what the question is about. */
  subject?: string;
  /** `chant workspace points ask <point> --store ledger` (#3815): hold the question on chant/lifecycle rather than in the working tree. */
  store?: "tree" | "ledger";
  /** `chant workspace points answer <id> --answer <value>` (#2739): the people's answer. */
  answer?: string;
  /** `chant workspace drift --read <state|plan|refresh|live-read|ownership>` and `chant lifecycle drift --read` (behold#995): the read to ask the member's engine for. Unset, the member kind's default read. */
  driftRead?: string;
  /** `chant workspace drift --stream` (behold#995): print the drift stream (drift-start, records, drift-settle) as NDJSON instead of one document. */
  stream?: boolean;
  /** `chant workspace drift --resource <addr>` and `chant lifecycle drift --resource` (behold#995): read one resource, through `choudoufu live-plan -resource` on a choudoufu member. */
  resource?: string;
  /** `chant workspace graph --no-cache` (#2876): read every member, bypassing the per-member cache. */
  noCache?: boolean;
  /** `chant workspace graph --composites` (#2662): print each composite instance with the components that can deploy it. */
  composites?: boolean;
  /** `chant workspace graph --intent <path[:start-end]|path#symbol|member/node|sha>` (#2651): the region the intent graph is over. Empty with `--record`. */
  intent?: string;
  /** `chant workspace graph --intent` and `chant workspace runs` (#3035): follow squash merges to their pull requests' original commits, fetching missing pull request refs. */
  followSquash?: boolean;
  /** `chant workspace graph --intent --record <id>`: walk one decision record over every entry its constrains lists. */
  record?: string;
  /** `chant workspace patch <range> --path <p>`: only these paths, from the workspace root. Repeatable. */
  paths?: string[];
  /** `chant workspace patch <range> --max-bytes <n>`: the most hunk text printed for one file. */
  maxBytes?: number;
  /** `chant workspace patch [<commit>] --worktree`: the working tree against the commit (HEAD unless given). */
  worktree?: boolean;
  /** `chant workspace check --changes <base>..<head>` (#2773): the diff the forward coverage check maps to records. */
  changes?: string;
  /** `chant workspace check --changes ... --severity off|warn|fail` (#2773): in place of the declaration's `changes.severity`. */
  severity?: string;
  /** `chant workspace records --current` (#2546): leave out records a closed record supersedes. */
  current?: boolean;
  /** `chant workspace records --uncommitted` (#3160): only the records the working tree holds modified or new against HEAD. */
  uncommitted?: boolean;
  /** `chant workspace records amend <id> --set <file|->` (#2670): the JSON fields to set. */
  set?: string;
  /** `chant workspace records amend|review|close <id> --expect <digest>` (#3173): the record's digest the caller last read; the write is refused with record-conflict when it has moved on. */
  expect?: string;
  /** `chant workspace records review <id> --verdict <v>` (#2670): agree, dissent or abstain. */
  verdict?: string;
  /** `chant workspace box listing set <member> --cover <image>` (#3308): a PNG, JPEG or WebP picture to copy in as the box's cover. */
  cover?: string;
  /** `chant workspace box listing set <member> --cover <image> --cover-path <path>` (#3308): where the cover goes, from the workspace root. */
  coverPath?: string;
  /** `chant workspace box publish <member> --records` (#3165): publish the records kept uncommitted instead of a work item. */
  records?: boolean;
  /** `chant workspace wip save --label <text>` (#3172): what the caller calls the snapshot, such as a turn id. */
  label?: string;
  /** `chant workspace wip --branch <branch>` (#3172): list one branch's snapshots. `chant components pr-apply|pr-record --branch <branch>` (#4292): the branch pushed, which `ci.branches` routes members by; default the forge's GITHUB_REF_NAME or CI_COMMIT_BRANCH. */
  branch?: string;
  /** `chant ci workflow --workflow <name>`, repeatable (#3573): a workflow whose completion triggers a tick, beside those the scan finds. Also `chant ci init --workflow <name>` (#4168 step 6), the prescribed workflow to set up. */
  ciWorkflows?: string[];
  /** `chant ci init --security <group>`, repeatable (#4168 step 6): a security group to turn on. */
  securityGroups?: string[];
  /** `chant ci run plan|apply --commit <sha>` (#4094): the commit the job runs at. Default `HEAD`. */
  commit?: string;
  /** `chant ci run --pass-env <NAME>`, repeatable (#4094): a variable of the runner's environment the job gets, beside the few it always gets. */
  passEnv?: string[];
  /** `chant ci run|serve --secrets <file>` (#4096): the host's secrets file. Default the file `CHANT_CI_SECRETS` names. */
  ciSecrets?: string;
  /** `chant ci workflow --chant <command>` (#3573): the command the tick step runs chant with, in place of the npx pin. Also `chant ci run --chant` (#4094): what runs chant in the job. */
  ciChant?: string;
  /** `chant components pr-post --result <result>` (#4295): the plan job's own result. `failure` or `cancelled` fails the `chant/plan` status. */
  planResult?: string;
  /** `chant ci run|serve --no-status` (#4097): post no commit status for the job. `chant components pr-plan|pr-apply --no-status` (#4161): post neither the status nor the note. */
  noStatus?: boolean;
  /** `chant ci run|serve --status-url <template>` (#4097): the link a job's status carries. `{key}` is `<pr>/<commit>[/<member>]`, as `--report-url` keys it. */
  statusUrl?: string;
  /** `chant ci run --run-index-limit <n>` (#4098): how many runs the index at the report URL keeps. Default 200. */
  runIndexLimit?: number;
  /** `chant ci serve --repo <owner/repo>` (#4095): the repository it polls. */
  ciRepo?: string;
  /** `chant ci serve --max-jobs <n>` (#4095): how many jobs run at once. Default 1. */
  maxJobs?: number;
  /** `chant ci serve --author <login>`, repeatable (#4095): plan only pull requests these logins opened. */
  ciAuthors?: string[];
  /** `chant ci serve --rerun-failed` (#4095): run again the failed apply at the target's head and failed plans of open heads. */
  rerunFailed?: boolean;
  /** `chant ci workflow --install <command>` (#3573): a step before the tick that installs what `--chant` runs. */
  ciInstall?: string;
  /** `chant ci workflow --token-secret <NAME>` (#3573): the repository secret the tick's tag push authenticates with. */
  ciTokenSecret?: string;
  /** `chant ci workflow --app-id-var <VAR>` (#3573): the Actions variable holding the GitHub App id whose token pushes the tags. */
  ciAppIdVar?: string;
  /** `chant ci workflow --app-key-secret <NAME>` (#3573): the secret holding that App's private key. */
  ciAppKeySecret?: string;
  /** `chant ci workflow --runner-key-secret <NAME>` (#4031): the secret holding the runner key the tick signs its tags with. */
  ciRunnerKeySecret?: string;
  /**
   * `chant workspace records review <id> --by <principal>` (#2670): the
   * reviewer, as the caller names them. Also `chant workspace records new
   * --by <name>` (#2756): the record's proposer, or its decider when it
   * opens straight into a later state; see {@link ChannelOptions.by} in
   * `records-write.ts`.
   */
  by?: string;
  /** `chant ci serve|run --setup-key` (#4099): make the host's runner key in the state directory and print its public half. */
  setupKey?: boolean;
  /** `chant ci serve|run --setup-key --trust` (#4099): list the runner key in .chant/trust.json on a branch pushed for review. */
  trustKey?: boolean;
  /**
   * `chant ci serve --unsigned` (#4099): serve without signing. Since #4156
   * that is the default without a trusted key, so it only skips the key, and
   * is ignored when ci.green.signedSince requires signed runs.
   */
  unsigned?: boolean;
  /** `chant ci run --in-place` (#4156): run the job in this checkout at HEAD, as a generated forge job does. */
  ciInPlace?: boolean;
  /** `chant ci run --require-runner-start` (#4147): refuse the job unless a runner-start statement names it. */
  requireRunnerStart?: boolean;
  /** `chant ci runner-start sign --job <json|@file>` (#4147): the CI job a runner was started for. */
  ciJob?: string;
  /** `chant ci run --no-push` (#4156): write the run record on the local chant/lifecycle and push nothing. */
  noPush?: boolean;
  /** `chant ci serve|run --setup-key --trust --principal <name>` (#4099): the principal the runner key is listed for. */
  ciPrincipal?: string;
  /** `chant workspace trust runner add <principal> --class runner|service` (#3510): the runner entry's class. */
  runnerClass?: string;
  /**
   * `chant workspace records review <id> --sign [<key file>]` (#2687): the key that seals the verdict, or true for git's user.signingkey.
   * On `records new` and `records amend`, the key that seals the record's author (#2688).
   * On `chant approve` and `chant run approve`, the key that seals the gate approval (#3163).
   */
  sign?: string | true;
  /**
   * `chant approve <op> <gate> --relayed-by <principal>` and `chant workspace
   * points answer <id> --relayed-by <principal>` (#3402): the principal that
   * carried the approval or answer to chant on behalf of the person it names.
   */
  relayedBy?: string;
  /** `chant workspace records review <id> --session <id>` (#2670): the review session the verdict was given in. */
  session?: string;
  /** `chant workspace records new <kind> --prefix <prefix>` (#2670): the id prefix to allocate under. */
  prefix?: string;
  /** `chant workspace records|verify --require attested` (#2547): the provenance level a gate requires. */
  require?: string;
  /** `chant workspace evidence sign --key` (a runner's Ed25519 PEM) and `signers sign --key` (an ssh private key) (#2553). Also `chant ci tick --key` (#4031): the runner key the tick signs its tags with. */
  key?: string;
  /** `chant workspace evidence sign --check-id <id>` (#2553): the check the evidence is for. */
  checkId?: string;
  /** `chant workspace evidence sign --claim <file>` (#2553): hashed into the evidence. */
  claim?: string;
  /** `chant workspace evidence sign --environment <file>` (#2553): the runner environment, hashed into the evidence. */
  environment?: string;
  /** `chant workspace init --from tfc|spacelift --input <file>` (#3178): an exported file read instead of the API. */
  input?: string;
  /** `chant workspace init --from tfc --org <name>` (#3178): the Terraform Cloud organization. */
  org?: string;
  /** `chant workspace init --from spacelift --endpoint <url>` (#3178): the account's GraphQL endpoint. */
  endpoint?: string;
  /** `chant workspace runs statement <id> --signer <principal>` (#3192): the runner principal that will sign. */
  signer?: string;
  /** `chant workspace evidence verify --envelope <file>` (#2553). */
  envelope?: string;
  /** `chant workspace signers rotate --threshold <n>` (#2553). */
  threshold?: string;
  /**
   * `chant build --root-only` and `chant lint --root-only` (#2537): run on the
   * root project of a declared workspace, members left out, instead of
   * refusing with `WSP000`.
   */
  rootOnly?: boolean;
  /**
   * `chant workspace check --generated` (#2641): run each declared generator
   * and compare its output with the file in the tree. Off by default, since
   * generators run member code.
   */
  generated?: boolean;
  /** `chant workspace check --forge-repos <file>` (#3168): the forge's repository list, checked against an org workspace's repo members (WSP014, WSP015). */
  forgeRepos?: string;
  /**
   * `chant workspace build|lint|audit|graph --member <name>` (#2537): run only
   * the named members or example groups. Repeatable, and a comma list works too.
   * `chant components pr-plan|pr-apply --member <name>` (#3465) takes exactly
   * one: the workspace member whose pull-request loop runs.
   */
  members?: string[];
  /**
   * `chant search "<q>" --ambient --live --env <name>` (#1278) — also report
   * resources of a kind this estate manages that exist in the account without
   * being declared or referenced. What "which of my security groups are
   * unused" is asking about, and unreachable from a state file.
   *
   * Opt-in: it asks the provider what exists rather than resolving out from
   * what is declared, which is a broader read and a different claim.
   */
  ambient?: boolean;
  /**
   * `chant search "<q>" --at <ref> --check-live --env <name>` (#1268) —
   * additionally read the estate live and diff the matched rows against the
   * snapshot the answer came from, reusing `diffLive` (the same engine
   * `lifecycle diff --live` uses) scoped to just those rows. Requires `--at`.
   */
  checkLive?: boolean;
  /**
   * `chant search "<q>" --live --check-snapshot --env <name>` (#1268) — the
   * reverse of `--check-live`: answer live, diff the matched rows against the
   * most recently recorded snapshot. Requires `--live`.
   */
  checkSnapshot?: boolean;
  /**
   * `chant search "<q>" --check-live|--check-snapshot --fail-on-drift`
   * (#1268) — exit non-zero when the scoped check finds drift, so it is usable
   * as a CI gate. Meaningless without one of the two flags above.
   *
   * `chant run <op> --fail-on-drift` (#3675) — exit 2 instead of 0 when the
   * run completes and its `Drift` outcome is true, the same as the Op
   * declaring `failOn: "drift"`. A failed run still returns 1, a gated one 3.
   */
  failOnDrift?: boolean;

  /** `chant dev surface-diff --run-examples` — also run the example build harness */
  runExamples?: boolean;
  /** `chant dev surface-diff --pinned-digest <file>` — path to SHA-256 digest file for supply-chain verification */
  pinnedDigest?: string;
  /** `chant dev surface-diff --check` — verify the committed baseline matches a fresh regen; exit non-zero if it drifted. Never writes the snapshot. */
  check?: boolean;
  /** `chant dev surface-diff --update-snapshot --bump` — bump the lexicon's package.json version by the drift severity so the accepted surface is publishable (#616). */
  bump?: boolean;
  /** `chant components release record --component <name>` (#568) — component name for the release record being appended. Also `chant components export <env> --component <name>` (#929) — which component's most recent recorded build to export. */
  component?: string;
  /** `chant components release record --digest <sha256:...>` (#568) — artifact digest to record, joining this release to the build archive/ledger. Also `chant components export --digest <manifestDigest>` (#929) — a build archive manifest digest to export directly, bypassing env/component resolution. */
  digest?: string;
  /** `chant components release record --release-plan <file>` (ws-055, #2733) — path to a release plan JSON file, persisted content-addressed to `_plans/<digest>.json` on chant/lifecycle and read back through the read contract (`chant workspace status --json`). The plan's own `digest` field supplies `--digest` when it is omitted, and must match it when both are given. Distinct from `--plan` (#2300, below), the Op gate-approval plan digest. */
  releasePlanFile?: string;
  /** `chant components promote --release <label|digest>` (#4026): deploy under that release, reading the templates its target for `--to` recorded. `chant run --components --release <label|digest>` (#4043): the run is of that release, which must have been cut from the checked-out commit and have a target for `--env`; the release records the run writes name it. */
  release?: string;
  /** `chant release cut --build <command>` (#4026): the shell command run in the member's directory before each environment's templates are read, with `CHANT_ENV` set to the environment. */
  buildCommand?: string;
  /** `chant release compile --artifacts` (#4026, internal): build the artifacts of `--component` instead of compiling the environment. */
  artifacts?: boolean;
  /** Every `--digest` value, in order (#2602). `chant components promote --digest <component>=<sha256:...>` is repeatable, one per component; the other commands read the single {@link digest}. */
  digests?: string[];
  /** `chant components release record --git-sha <sha>` (#568) — git commit the deploy was built from. */
  gitSha?: string;
  /** `chant components release record --run-id <id>` (#568) — orchestrator/CI run identifier. */
  runId?: string;
  /** `chant components release record --actor <name>` (#568) — who/what triggered the deploy. */
  actor?: string;
  /** `--approver <name>` (#1035) — who approved a gated change. Read by `chant approve` and `chant run approve` (recorded as `resolvedBy` on the gate-resolution fact, taking precedence over `--actor`) and by `chant components release` (recorded on the release ledger). Optional; absent for ungated changes. */
  approver?: string;
  /** `chant run approve <op> <gate> --on <lexicon> --durable-requests` (#2126) — reserved. It would resolve the gate by answering the hosting runtime's own pending request instead of posting a follow-up prompt. No runtime implements it: fountain's needs the request-answer path from BinaryBourbon/fountain#1635, which has not shipped, and refuses by name rather than reporting a resolution it did not make. */
  durableRequests?: boolean;
  /** `chant components status <env> --compare-to <env>` (#568) — a second environment to cross-check the same component's recorded digest against. */
  compareTo?: string;
  /** `chant run --components <name> --env <env> --no-release-record` (#597) — opt out of auto-emitting a release-ledger record after a successful component deploy. Default (flag omitted): recording is ON. Also settable project-wide via `chant.config.ts`'s `release.autoRecord: false`. */
  noReleaseRecord?: boolean;
  /** `chant run <op>` / `chant run --components <name>` `--no-record` (#3955) — run every step but record nothing on `chant/lifecycle` and push nothing; a gate step fails. `CHANT_NO_RECORD=1` does the same for every chant process that inherits it (../../lifecycle/no-record.ts). */
  noRecord?: boolean;
  /** `chant run --components <name> --dump-outputs <file>` — after the run, write the accumulated cross-component/cross-stack outputs (JSON, keyed by component name) to `<file>`, for a downstream job to `--seed-outputs`. */
  dumpOutputs?: string;
  /** `chant run --components <name> --digest-file <file>` (#2602) — after a successful run, write one `<component>=<digest>` line per release the run recorded to `<file>`, the form `chant components promote --digest` takes, so a generated promote job promotes exactly the release its pipeline run built. Written empty when nothing was recorded. */
  digestFile?: string;
  /** `chant run --components <name> --seed-outputs <file>` (repeatable) — before the run, load each JSON outputs file (as written by `--dump-outputs`) and seed cross-component/cross-stack resolution with it, so a `stackOutput()`/`@<dep>.publish.*` reference to a component that ran in an earlier job resolves. */
  seedOutputs?: string[];
  /** `chant build --fold` (#1022/#1023, epic #1019) — opt-in: fold source modules statically instead of importing/running them; folds resource constructors and composite factory calls, falling back to run per-file for anything the folder can't represent (a cross-file-only reference, a re-export, `export default`, …). Also settable project-wide via `chant.config.ts`'s `build.fold: true`; the flag always wins when set. Default (flag omitted): the existing run path, unchanged. */
  fold?: boolean;
  /** `chant build --sandbox` (#1045 Phase 2) — opt-in: run-fallback source files (or every file, without `--fold`) execute together, isolated, in one sandboxed child process instead of in-process. Also settable project-wide via `chant.config.ts`'s `build.sandbox: true`; the flag always wins when set. Default (flag omitted): in-process execution, unchanged. */
  sandbox?: boolean;
  /** `chant build --fold --fold-rank` (#1083) — after a `--fold` build, print blockers ranked by dominator retained-count over the forward import-failure graph, plus the separate reverse-taint bucket (chant #1044). Bare boolean form; see {@link foldRankCollapsedFile} for the file-writing form. No-op without `--fold`. */
  foldRank?: boolean;
  /** `chant build --fold --fold-rank <path>` (#1083) — same ranking as {@link foldRank}, ALSO exported in Brendan Gregg collapsed stack format (weighted by retained count) to `<path>`, so it renders in any flame/icicle viewer. Mutually exclusive with the bare-boolean form at the parse level (same context-sensitive lookahead as `--report`), but the text report still prints either way. */
  foldRankCollapsedFile?: string;
  /** `chant build --param name=value` (#1064) — repeatable. Bound to `params.<name>` (`@intentius/chant/params`) for source to reference, after validation against `chant.config.ts`'s declared `buildParams`. Highest precedence over `--params-file`/a declared `env` mapping/the declared `default`. */
  param?: string[];
  /** `chant build --lexicon-output <lexicon>=<path>` — repeatable. Writes that lexicon's output to its own file, so one project can declare several lexicons (otel and prometheus) without their outputs sharing a file. Lexicons not named are built into `--output` when given, and skipped otherwise. */
  lexiconOutput?: string[];
  /** `chant build --params-file <path>` (#1064) — a JSON file of `{ "name": value }` build-time parameter values. Second precedence, after `--param`. */
  paramsFile?: string;
  /** `chant graph --components --format ir --projection <lexicon>` (#989) — add
   * the CI/pipeline projection (stages/jobs/`needs`) to the component-graph IR,
   * synthesized by `<lexicon>`'s `generateComponentPipeline` (gitlab, github,
   * forgejo today) — the same generator `chant build --components --generate
   * <lexicon>` uses, reused rather than re-derived. */
  projection?: string;
  /** `chant operator --interval <duration>` (#1485) — poll interval between rounds, e.g. "30s", "5m". Default: 60s. */
  interval?: string;
  /** `chant operator --lease-ttl <duration>` (#1485) — how long an acquired lease is valid before it's reclaimable by another operator. Default: 5m. */
  leaseTtl?: string;
  /**
   * `chant operator --steward [<name>]` (#2731) — run a declared steward's
   * local form: its scheduled Ops on their crons, under the steward's own
   * lease. `""` when the flag is given without a name, which picks the
   * project's only steward.
   */
  steward?: string;
  /** `chant workspace runs --unit <id>` (#3033): only the agent runs on this work item. */
  unit?: string;
  /** `chant workspace runs --decision <id>` (#3033): only the agent runs that carried out this decision. */
  decision?: string;
  /** `chant workspace work claim|renew|release <id> --holder <name>` (#2732): who holds, or releases, the work lease. */
  holder?: string;
  /** `chant run <op> --work <id>` (#2748): the work item an Op with a work lease runs under. `chant workspace check --changes --work <id>` (#2773): the work item in hand. */
  work?: string;
  /** Every `--work <id>`, in order: `chant release compose` (#4168 4.3) takes several. */
  works?: string[];
  /** `chant workspace work claim|renew <id> --ttl <seconds|duration>` (#2732): how long the lease lasts unless renewed. */
  ttl?: string;
  /** `chant workspace work renew|release <id> --token <token>` (#2732): the fencing token the caller holds. */
  token?: string;
  /** `chant workspace work release <id> --outcome <outcome>` (#2732): how the work ended, one of the closed list WORK_LEASE_OUTCOMES (#3147). */
  outcome?: string;
  /** `chant operator --once` (#1485) — run a single round and exit, instead of looping until Ctrl-C. Also the offline test/cron-invoker story. */
  once?: boolean;
  /** `chant approve <op> <gate> --note <text>` (#1485) — optional free-text prose recorded on the gate-resolution fact. The PR link belongs in `--url` since #2028; this is for everything that isn't the link. */
  note?: string;
  /** `chant approve policy-override <subject> --reason <text>` (#3760): why a denied plan goes out anyway, recorded as the override's note. */
  reason?: string;
  /** `chant approve policy-override <subject> --rule <id>` (#3760), repeated: the rules that denied the plan, which the override names. */
  rules?: string[];
  /** `chant approve <op> <gate> --expire` (#2119) — clear the gate's standing pending fact instead of approving it, so the next run decides the gate from scratch and records a fresh one. Writes no resolution: nothing is approved, the wait is only restarted. */
  expire?: boolean;
  /**
   * `chant approve --allow-same-origin` (chant#2384) — record a resolution
   * from the same channel that reached the gate, which is refused by default
   * on a model-authored channel.
   */
  allowSameOrigin?: boolean;
  /** `chant approve --role <name>` (#2508) — roles the approver claims, recorded on the approval. Nothing trusts them: a quorum (#4290) and a gate policy (#4324) read roles from `.chant/trust.json` at base, for a sealed approval. Repeatable; a comma list also works. */
  roles?: string[];
  /** `chant approve --agent` (#2508) — record the approval as an agent's. An agent never counts toward a quorum; it passes a gate only through a policy permit in `enforce` mode. */
  agent?: boolean;
  /** `chant approve <op> <gate> --plan <digest>` (#2300) — the plan this approval is for, as `sha256:<64 hex>`. Omitted, the digest is taken from the gate's standing pending fact, which is the plan the run that stopped at the gate actually produced; pass it to approve a plan explicitly, or to approve one before any run has recorded a pending fact. */
  plan?: string;
  /** `chant operator log --op <name>` (#2029) — restrict the tick history to one ConvergeOp by name. Omitted, every discovered ConvergeOp's ticks are merged into one timeline. */
  op?: string;
  /** `chant operator log --since <iso>` (#2029) — only entries at or after this ISO-8601 instant. `chant workspace records --since <rev>` (#2673) — the revision to compare the records with. `chant workspace metrics --since <date>` (#4039) — the start of the window the metrics count. */
  since?: string;
  /** `chant ledger`, `chant workspace records` and `chant workspace runs --where <field><op><value>` (#4363): typed filters, repeatable, all of which have to hold. */
  where?: string[];
  /** `chant operator log --limit <n>` (#2029) — keep only the newest n entries (still printed oldest-first). */
  limit?: number;
  /** `chant approve <op> <gate> --url <url>` (#2028) — the address this resolution happened at (the PR/MR that carried the change), recorded typed on the gate-resolution fact so a reader is not sniffing `--note` for something link-shaped. Defaults to the PR/MR the surrounding CI job is for, when there is one. Must be an absolute http/https URL. */
  url?: string;
}

/**
 * Declarative command definition for the CLI registry.
 */
export interface CommandDef {
  /** Primary command name, e.g. "build", "dev generate", "serve lsp" */
  name: string;
  /** If true, load lexicon plugins before calling handler */
  requiresPlugins?: boolean;
  /**
   * chant#2591, chant#2589 — the command never evaluates the project's
   * `chant.config.ts`, so `main` does not load it before dispatch either. Such
   * a command reads what it needs from the config statically
   * (../config-static.ts). A function decides per invocation.
   */
  runsNoConfig?: boolean | ((args: ParsedArgs) => boolean);
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
/**
 * Command aliases. `chant lc …` is sugar for `chant lifecycle …`, and
 * `chant sync` for `chant update`, the command that syncs lexicon types
 * (chant #3988).
 */
const COMMAND_ALIASES: Record<string, string> = { lc: "lifecycle", sync: "update" };

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
