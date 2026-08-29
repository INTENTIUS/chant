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
  /** `chant run --components <name|all> --progress-json` — stream one NDJSON `RunProgressEvent` (../../components/run-progress.ts) per line to stdout while the run executes (local executor only), so a consumer can render live wave/component/phase/step progress instead of tailing raw logs. Purely additive: run semantics, ordering, and exit code are unchanged; omitted (undefined, not false) when the flag isn't passed. */
  progressJson?: boolean;
  live: boolean;
  /** `chant migrate --from <name>` (default "github") */
  migrateFrom?: string;
  /** `chant import --kustomize <dir>` — render the kustomization, then import (#1548) */
  kustomize?: string;
  /** `chant carve advise --state <path>` — opt-in .tfstate for accurate instance counts */
  statePath?: string;
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
  /** `chant lifecycle rollback --dry-run` — compute the rollback delta and print it; open no PR, push nothing, leave no branch. */
  dryRun?: boolean;
  /** `chant lifecycle teardown <env> --yes` — execute the planned deletion
   * (#1222). Without it the command plans and stops. */
  yes?: boolean;
  /** `chant lifecycle teardown <env> --yes --confirm-prod` — the non-interactive
   * form of the extra confirmation a production-like environment name demands
   * (#1222). Meaningless without `--yes`. */
  confirmProd?: boolean;
  /** `chant import --verbatim` — keep server-defaulted fields in live import */
  verbatim?: boolean;
  /** `chant lifecycle … --src <dir>` — build root override for lifecycle commands */
  src?: string;
  /** `--env <name>` — active environment: sets CHANT_ENV so env-aware source
   * re-evaluates for that environment (`build` + `graph`), and drives policy. */
  env?: string;
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
  /** `chant list --components` / `chant graph --components` — surface discovered
   * `Component` declarations (#560) instead of/alongside lexicon resources. */
  components?: boolean;
  /** `chant build --components --generate <lexicon>` — generate mode (#563):
   * synthesize CI YAML from discovered components instead of running a normal
   * lexicon build. Only "gitlab" is implemented for v1. */
  generate?: string;
  /** `chant graph --format ir --detail <0..3>` — graph IR detail tier */
  detail?: number;
  /** `chant graph --lens <kind>:<target>` — focus the graph IR on a slice */
  lens?: string;
  /** `chant search --show a,b` — extra attributes to include per matched row (#1139). */
  show?: string;
  /** `chant search --explain` — append a footer: universe count + why non-matches were excluded (#1139). */
  explain?: boolean;
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
  /** `chant audit --tier merge-worthy|all` */
  tier?: string;
  /** `chant audit --fail-on merge-worthy|warning|none` */
  failOn?: string;
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
  /** `chant components release record --git-sha <sha>` (#568) — git commit the deploy was built from. */
  gitSha?: string;
  /** `chant components release record --run-id <id>` (#568) — orchestrator/CI run identifier. */
  runId?: string;
  /** `chant components release record --actor <name>` (#568) — who/what triggered the deploy. */
  actor?: string;
  /** `--approver <name>` (#1035) — who approved a gated change. Supplied to `chant run signal` (rides the gate signal payload into workflow history) and to `chant components release` (recorded on the release ledger). Optional; absent for ungated changes. */
  approver?: string;
  /** `chant components status <env> --compare-to <env>` (#568) — a second environment to cross-check the same component's recorded digest against. */
  compareTo?: string;
  /** `chant run --components <name> --env <env> --no-release-record` (#597) — opt out of auto-emitting a release-ledger record after a successful component deploy. Default (flag omitted): recording is ON. Also settable project-wide via `chant.config.ts`'s `release.autoRecord: false`. */
  noReleaseRecord?: boolean;
  /** `chant run --components <name> --dump-outputs <file>` — after the run, write the accumulated cross-component/cross-stack outputs (JSON, keyed by component name) to `<file>`, for a downstream job to `--seed-outputs`. */
  dumpOutputs?: string;
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
  /** `chant operator --once` (#1485) — run a single round and exit, instead of looping until Ctrl-C. Also the offline test/cron-invoker story. */
  once?: boolean;
  /** `chant approve <op> <gate> --note <text>` (#1485) — optional free-text context recorded on the gate-resolution fact (e.g. a PR URL). */
  note?: string;
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
