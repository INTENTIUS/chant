import { resolve } from "node:path";
import { build } from "../../build";
import { takeSnapshot } from "../../lifecycle/snapshot";
import { readSnapshot, readSnapshotAt, readEnvironmentSnapshots, listSnapshots, fetchLifecycle, pushLifecycle, snapshotStorageKey, StaleLifecycleBranchError } from "../../lifecycle/git";
import { deepDiffForLexicon } from "../../lifecycle/deep-observe";
import { countPropertyDrift, type DeepDiffResult } from "../../lifecycle/deep-diff";
import {
  acceptDeviations,
  baselineForLexicon,
  emptyBaseline,
  readObservationBaseline,
  writeObservationBaseline,
  OBSERVATION_BASELINE_FILE,
  type DeviationToAccept,
  type ObservationBaseline,
} from "../../lifecycle/observation-baseline";
import { computeBuildDigest, diffDigests } from "../../lifecycle/digest";
import { diffLive, diffLiveArtifacts, diffSnapshots, type LiveDiffResult, type LiveArtifactDiffResult, type SnapshotDiffResult } from "../../lifecycle/live-diff";
import { buildChangeSet, renderChangeSet, gitlabMrReport, summarize, type ChangeSet } from "../../lifecycle/change-set";
import {
  formatUnobserved,
  mergeObservations,
  normalizeObservation,
  unobservedAll,
  type NormalizedObservation,
  type UnobservedEntity,
} from "../../observation";
import { discoverComponents } from "../../components/discover";
import { cfnDeployStacks } from "./components";
import { affectedStacks } from "../../lifecycle/affected";
import { rollbackToRevision } from "../../lifecycle/rollback";
import { loadChantConfig, environmentNames } from "../../config";
import { applyLiveEndpoint } from "../../live-endpoint";
import { formatError, formatWarning, formatSuccess, formatBold } from "../format";
import type { CommandContext } from "../registry";
import type { LifecycleSnapshot } from "../../lifecycle/types";
import type { SerializerResult } from "../../serializer";
import type { ObservationLexicon, ResourceMetadata, ArtifactMetadata } from "../../lexicon";
import type { BuildResult } from "../../build";
import type { ParsedArgs } from "../registry";
import type { ChantConfig } from "../../config";

/**
 * Resolve the build root for a lifecycle command. The project root (where
 * chant.config.ts lives) is always ".", but the *build* can be scoped to a
 * subdirectory so a mixed-layout project — chant `src/` next to app code with
 * import side effects — only synthesizes its infra. Precedence: `--src` flag,
 * then `config.sourceDir`, then "." (the root). Snapshot/diff/plan all use this
 * so their build digests stay consistent.
 */
function resolveBuildRoot(args: ParsedArgs, config: ChantConfig): string {
  return resolve(args.src ?? config.sourceDir ?? ".");
}

/** One stack a lifecycle command operates on: its build root and, for a
 * multi-stack project, the deployed CloudFormation stack name it observes
 * against. */
interface StackTarget {
  /** The deployed stack name to observe (undefined ⇒ single-stack convention:
   * the stack named after the environment). */
  stack?: string;
  /** Build root to synthesize this stack from, scoped so its logical ids match
   * what the stack actually deploys. */
  root: string;
  /** Region the stack is deployed in, from `stacks[].region` (#1261). Without
   * it every stack is observed against the ambient region, so a multi-region
   * estate snapshots only the stacks that happen to share it and reports the
   * rest as "no valid resources or artifacts returned". */
  region?: string;
}

/**
 * The stacks a lifecycle command (`snapshot`/`diff`) iterates. A multi-stack
 * project declares them via `stacks` in chant.config (#932) — each built from
 * its own `src` and observed against its own live stack `name`. A single-stack
 * project (no `stacks`) resolves to one target built from `sourceDir`/root and
 * observed as the stack named after the environment (unchanged behavior). An
 * explicit `--src` always wins and forces a single scoped target.
 */
function resolveStackTargets(args: ParsedArgs, config: ChantConfig): StackTarget[] {
  if (args.src) return [{ root: resolve(args.src) }];
  if (config.stacks && config.stacks.length > 0) {
    return config.stacks.map((s) => ({ stack: s.name, root: resolve(s.src), region: s.region }));
  }
  return [{ root: resolveBuildRoot(args, config) }];
}

/**
 * chant lifecycle snapshot <environment> [lexicon]
 */
export async function runLifecycleSnapshot(ctx: CommandContext): Promise<number> {
  const { args, plugins } = ctx;
  const environment = args.extraPositional;
  const lexiconFilter = args.extraPositional2;

  if (!environment) {
    console.error(formatError({ message: "Environment is required: chant lifecycle snapshot <environment> [lexicon]" }));
    return 1;
  }

  // Validate environment against config
  const projectPath = resolve(".");
  const { config } = await loadChantConfig(projectPath);
  const declaredEnvNames = environmentNames(config.environments);
  if (declaredEnvNames && !declaredEnvNames.includes(environment)) {
    console.error(formatError({
      message: `Unknown environment "${environment}"`,
      hint: `Defined environments: ${declaredEnvNames.join(", ")}`,
    }));
    return 1;
  }

  // Filter plugins if lexicon specified
  const targetPlugins = lexiconFilter
    ? plugins.filter((p) => p.name === lexiconFilter)
    : plugins;
  const targetSerializers = targetPlugins.map((p) => p.serializer);

  const observingPlugins = targetPlugins.filter((p) => p.describeResources || p.listArtifacts);
  if (observingPlugins.length === 0) {
    console.error(formatError({
      message: "No plugins implement describeResources or listArtifacts",
      hint: lexiconFilter ? `Lexicon "${lexiconFilter}" does not support state snapshots` : undefined,
    }));
    return 1;
  }

  // One target per stack (single-stack projects: exactly one). Each stack builds
  // from its own scoped root — so its logical ids match what it deploys — and
  // snapshots against its own live stack name (#932).
  const targets = resolveStackTargets(args, config);
  let anySnapshotSaved = false;
  let anyHardError = false;

  // #1166 — same self-sufficiency as `chant graph --live`: a snapshot is
  // always a live read, so an environment's declared endpoint applies here
  // too, unless the ambient shell already set it.
  const endpointResult = applyLiveEndpoint(config.environments, environment, observingPlugins.map((p) => p.name));
  if (endpointResult.notice) console.error(formatWarning({ message: endpointResult.notice }));

  try {
    for (const target of targets) {
      const label = target.stack ? `stack "${target.stack}"` : "project";
      const buildResult = await build(target.root, targetSerializers);
      if (buildResult.errors.length > 0) {
        console.error(formatError({ message: `Build failed for ${label} — fix errors before taking a snapshot` }));
        anyHardError = true;
        continue;
      }

      let result;
      try {
        result = await takeSnapshot(environment, observingPlugins, buildResult, {
          stack: target.stack,
          region: target.region,
        });
      } catch (err) {
        if (err instanceof StaleLifecycleBranchError) {
          console.error(formatError({
            message: `Another snapshot completed for chant/lifecycle after this run started (env: ${environment}).`,
            hint: `Pull and retry: \`git fetch origin ${"chant/lifecycle"}:${"chant/lifecycle"}\` && \`chant lifecycle snapshot ${environment}\`.`,
          }));
          return 1;
        }
        throw err;
      }

      for (const w of result.warnings) {
        console.error(formatWarning({ message: w }));
      }
      for (const e of result.errors) {
        console.error(formatError({ message: e }));
      }

      if (result.snapshots.length > 0) {
        anySnapshotSaved = true;
        const prefix = target.stack ? `${target.stack}: ` : "";
        const counts = result.snapshots
          .map((s) => `${s.lexicon}(${Object.keys(s.resources).length})`)
          .join(" ");
        console.error(formatSuccess(`${prefix}Snapshot saved to chant/lifecycle (${counts})`));
      }
      if (result.errors.length > 0) anyHardError = true;
    }

    return anyHardError && !anySnapshotSaved ? 1 : 0;
  } finally {
    endpointResult.restore();
  }
}

/**
 * chant lifecycle show <environment> [lexicon]
 */
export async function runLifecycleShow(ctx: CommandContext): Promise<number> {
  const environment = ctx.args.extraPositional;
  const lexiconFilter = ctx.args.extraPositional2;

  if (!environment) {
    console.error(formatError({ message: "Environment is required: chant lifecycle show <environment> [lexicon]" }));
    return 1;
  }

  // Fetch from remote first
  await fetchLifecycle();

  if (lexiconFilter) {
    const content = await readSnapshot(environment, lexiconFilter);
    if (!content) {
      console.error(formatError({ message: `No snapshot found for ${environment}/${lexiconFilter}` }));
      return 1;
    }

    const snapshot: LifecycleSnapshot = JSON.parse(content);
    printSnapshotTable(snapshot);
  } else {
    const snapshots = await readEnvironmentSnapshots(environment);
    if (snapshots.size === 0) {
      console.error(formatError({ message: `No snapshots found for environment "${environment}"` }));
      return 1;
    }

    for (const [lexicon, content] of snapshots) {
      const snapshot: LifecycleSnapshot = JSON.parse(content);
      console.log(`\n${formatBold(`${environment}/${lexicon}`)} — ${Object.keys(snapshot.resources).length} resources — ${snapshot.timestamp}`);
      printSnapshotTable(snapshot);
    }
  }

  return 0;
}

/**
 * chant lifecycle rollback [<environment>] --to <ref>
 *
 * Open a PR restoring `sourceDir` to a prior git revision (#873). Source-level,
 * reviewable, no cloud mutation — a human merges, then a gated apply rolls the
 * env back. The `<env>` positional is PR context.
 */
export async function runLifecycleRollback(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const environment = args.extraPositional; // optional — PR context/title
  const ref = args.migrateTo; // the --to value
  if (!ref) {
    console.error(formatError({ message: "Target revision required: chant lifecycle rollback [<env>] --to <ref>" }));
    return 1;
  }
  const { config } = await loadChantConfig(resolve("."));
  const sourceDir = config.sourceDir ?? ".";
  try {
    const result = await rollbackToRevision({ ref, env: environment, sourceDir, cwd: resolve(".") });
    if (result.noop) {
      console.error(formatSuccess(`${sourceDir} already matches ${ref} — nothing to roll back`));
      return 0;
    }
    console.log(result.prUrl); // the PR URL — the consumer (behold) reads this from stdout
    console.error(formatSuccess(`Opened rollback PR on ${result.branch}`));
    return 0;
  } catch (err) {
    console.error(formatError({ message: `rollback failed — ${err instanceof Error ? err.message : String(err)}` }));
    return 1;
  }
}

/**
 * chant lifecycle diff <environment> [lexicon]
 */
export async function runLifecycleDiff(ctx: CommandContext): Promise<number> {
  const { args, plugins, serializers } = ctx;
  const environment = args.extraPositional;
  const lexiconFilter = args.extraPositional2;

  if (!environment) {
    console.error(formatError({ message: "Environment is required: chant lifecycle diff <environment> [lexicon]" }));
    return 1;
  }

  // `--between <refA> <refB>` (#822): diff two saved snapshots against each other.
  // Purely historical — no build, no cloud query; reads the orphan branch.
  if (args.betweenA && args.betweenB) {
    return runLifecycleDiffBetween({
      environment,
      lexiconFilter,
      refA: args.betweenA,
      refB: args.betweenB,
      json: !!args.json,
    });
  }

  // Filter serializers to target lexicon before building
  const targetSerializers = lexiconFilter
    ? plugins.filter((p) => p.name === lexiconFilter).map((p) => p.serializer)
    : serializers;

  // Fetch previous snapshots once (all stacks share the orphan branch).
  const { config } = await loadChantConfig(resolve("."));
  await fetchLifecycle();

  // One target per stack (single-stack projects: exactly one), each built from
  // its own scoped root and diffed against its own live stack name (#932).
  const targets = resolveStackTargets(args, config);
  const json = !!args.json;
  const perStackJson: Record<string, unknown> = {};
  let combinedLexiconsJson: Record<string, unknown> | undefined;
  let totalDrift = 0;
  let totalUnobserved = 0;
  let totalChecked = 0;
  let anyBuildError = false;

  // Accepted-deviation baseline (#1014). Read once for the whole run — it is
  // env-keyed, not stack-keyed, and every deep pass subtracts from the same
  // committed set. Absent is the normal state (nothing accepted yet).
  const baseline = args.live ? await readObservationBaseline(environment) : null;
  const accepted: Record<string, DeviationToAccept[]> = {};

  // #1166 — an environment can declare its own endpoint (a local emulator like
  // Floci), so `--live` is self-sufficient even when the ambient shell never
  // exported e.g. AWS_ENDPOINT_URL. Ambient always wins when it's already set.
  // Scoped to just the live reads below — restored in `finally`.
  const liveLexicons = args.live ? plugins.filter((p) => p.describeResources || p.listArtifacts).map((p) => p.name) : [];
  const endpointResult = applyLiveEndpoint(config.environments, environment, liveLexicons);
  if (endpointResult.notice) console.error(formatWarning({ message: endpointResult.notice }));

  try {
    for (const target of targets) {
      const buildResult = await build(target.root, targetSerializers);
      if (buildResult.errors.length > 0) {
        const label = target.stack ? `stack "${target.stack}"` : "project";
        console.error(formatError({ message: `Build failed for ${label} — fix errors before diffing` }));
        anyBuildError = true;
        continue;
      }

      const lexicons = lexiconFilter
        ? [lexiconFilter]
        : Array.from(buildResult.manifest.lexicons);

      if (args.live) {
        // Multi-stack component projects: observe each component's own cfn stack
        // and union (same fix runGraphLive / plan use), so a deployed resource
        // isn't reported "missing". Only when this target has no explicit stack.
        let componentStacks: string[] = [];
        if (!target.stack) {
          try {
            const disc = await discoverComponents(target.root, { sandbox: args.sandbox });
            const set = new Set<string>();
            for (const { component } of disc.components.values()) for (const s of cfnDeployStacks(component.deploy)) set.add(s);
            componentStacks = [...set];
          } catch {
            // no components / discovery failed → single-stack observe path
          }
        }
        const r = await runLifecycleDiffLive({
          environment,
          lexicons,
          plugins,
          buildResult,
          json,
          stack: target.stack,
          componentStacks,
          baseline,
          updateBaseline: args.updateBaseline,
        });
        totalDrift += r.totalDrift;
        totalUnobserved += r.totalUnobserved;
        totalChecked += r.totalLexiconsChecked;
        for (const [lexicon, deviations] of Object.entries(r.toAccept)) {
          (accepted[lexicon] ??= []).push(...deviations);
        }
        if (json) {
          if (target.stack) perStackJson[target.stack] = r.byLexicon;
          else combinedLexiconsJson = r.byLexicon;
        }
      } else {
        await runLifecycleDiffDigest({ environment, lexicons, buildResult, stack: target.stack });
      }
    }

    // `--update-baseline` (#1014): record what the deep pass just reported as
    // accepted, so it stops re-alerting. Runs before the summary lines so the
    // "no drift" verdict below still describes the run that produced it.
    if (args.live && args.updateBaseline) {
      await recordAcceptedBaseline(environment, baseline, accepted, json);
    }

    if (args.live) {
      if (json) {
        // Single-stack keeps the original `{ environment, lexicons }` shape
        // (behold's inspect diff, #852); multi-stack nests under `stacks`.
        console.log(
          JSON.stringify(
            combinedLexiconsJson !== undefined
              ? { environment, lexicons: combinedLexiconsJson }
              : { environment, stacks: perStackJson },
          ),
        );
      } else if (totalChecked === 0) {
        console.error(formatWarning({
          message: "No lexicons implement describeResources or listArtifacts — nothing to diff in --live mode",
        }));
        return 1;
      } else if (totalDrift === 0) {
        // Qualify the all-clear when part of the estate was never read (#1089):
        // "no drift" over an incomplete observation is not the same claim.
        console.error(
          totalUnobserved > 0
            ? formatWarning({
                message: `No drift detected across ${totalChecked} lexicon(s), but ${totalUnobserved} declared entity(ies) could not be observed — that part of the estate is unknown, not clean`,
              })
            : formatSuccess(`No drift detected across ${totalChecked} lexicon(s)`),
        );
      }
    }

    return anyBuildError ? 1 : 0;
  } finally {
    endpointResult.restore();
  }
}

/**
 * Write the accepted-deviation baseline (#1014) for everything the deep pass
 * reported this run, and push it on the same orphan branch the snapshots use.
 *
 * Acceptance is a deliberate, committed act — that is the whole difference
 * between this and a suppression flag — so the write is loud: it names the
 * count and the storage path, and a failed push says so rather than leaving
 * the operator believing the team's baseline moved.
 */
async function recordAcceptedBaseline(
  environment: string,
  existing: ObservationBaseline | null,
  accepted: Record<string, DeviationToAccept[]>,
  json: boolean,
): Promise<void> {
  const total = Object.values(accepted).reduce((n, d) => n + d.length, 0);
  if (total === 0) {
    if (!json) {
      console.error(formatWarning({
        message: "--update-baseline: nothing to accept — no property-level deviations were reported",
      }));
    }
    return;
  }
  let next = existing ?? emptyBaseline(environment);
  for (const [lexicon, deviations] of Object.entries(accepted)) {
    next = acceptDeviations(next, lexicon, deviations);
  }
  try {
    await writeObservationBaseline(next);
    const pushed = await pushLifecycle();
    if (!json) {
      console.error(formatSuccess(
        `--update-baseline: accepted ${total} deviation(s) into ${environment}/${OBSERVATION_BASELINE_FILE} on chant/lifecycle` +
          (pushed ? " (pushed)" : " (local only — no remote configured or push refused)"),
      ));
    }
  } catch (err) {
    console.error(formatError({
      message: `--update-baseline: could not write the baseline — ${err instanceof Error ? err.message : String(err)}`,
    }));
  }
}

interface BetweenDiffArgs {
  environment: string;
  lexiconFilter?: string;
  refA: string;
  refB: string;
  json: boolean;
}

/**
 * `chant lifecycle diff <env> --between <refA> <refB>` (#822). Diffs two saved
 * snapshots against each other — read-only, no build, no cloud query. Reads
 * `<ref>:<env>/<lexicon>.json` from the orphan branch at each ref and reports the
 * two-way delta per lexicon.
 */
async function runLifecycleDiffBetween(args: BetweenDiffArgs): Promise<number> {
  await fetchLifecycle();
  const { config } = await loadChantConfig(resolve("."));
  const lexicons = args.lexiconFilter ? [args.lexiconFilter] : config.lexicons ?? [];
  if (lexicons.length === 0) {
    console.error(formatError({ message: "No lexicons to diff — pass a lexicon or declare `lexicons` in chant.config." }));
    return 1;
  }

  const parseResources = (content: string | null): Record<string, ResourceMetadata> | null => {
    if (content === null) return null;
    try {
      return (JSON.parse(content) as LifecycleSnapshot).resources ?? {};
    } catch {
      return null;
    }
  };

  const byLexicon: Record<string, SnapshotDiffResult> = {};
  for (const lexicon of lexicons) {
    const prev = parseResources(await readSnapshotAt(args.environment, lexicon, args.refA));
    const next = parseResources(await readSnapshotAt(args.environment, lexicon, args.refB));
    if (prev === null && next === null) {
      if (!args.json) console.error(formatWarning({ message: `${lexicon}: not captured at either ref — skipping` }));
      continue;
    }
    byLexicon[lexicon] = diffSnapshots(prev ?? {}, next ?? {});
  }

  if (args.json) {
    console.log(JSON.stringify({ environment: args.environment, refA: args.refA, refB: args.refB, lexicons: byLexicon }, null, 2));
    return 0;
  }

  if (Object.keys(byLexicon).length === 0) {
    console.log(`No snapshots for ${args.environment} at ${args.refA} / ${args.refB}.`);
    return 0;
  }

  console.log(formatBold(`Snapshot diff — ${args.environment}: ${args.refA} → ${args.refB}`));
  for (const [lexicon, d] of Object.entries(byLexicon)) {
    console.log(
      `\n${formatBold(lexicon)} — ${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed, ${d.unchanged.length} unchanged`,
    );
    for (const name of d.added) console.log(`  + ${name}`);
    for (const name of d.removed) console.log(`  - ${name}`);
    for (const drift of d.changed) console.log(`  ~ ${drift.name} (${drift.changes.map((c) => c.path).join(", ")})`);
  }
  return 0;
}

interface DigestDiffArgs {
  environment: string;
  lexicons: string[];
  buildResult: BuildResult;
  /** Deployed stack name for a multi-stack project (#932); scopes the snapshot read. */
  stack?: string;
}

async function runLifecycleDiffDigest(args: DigestDiffArgs): Promise<number> {
  const currentDigest = computeBuildDigest(args.buildResult);
  if (args.stack) console.log(`\n${formatBold(`■ stack ${args.stack}`)}`);

  for (const lexicon of args.lexicons) {
    const content = await readSnapshot(args.environment, snapshotStorageKey(lexicon, args.stack));
    let previousDigest = undefined;
    if (content) {
      const snapshot: LifecycleSnapshot = JSON.parse(content);
      previousDigest = snapshot.digest;
    }

    const diff = diffDigests(currentDigest, previousDigest);

    console.log(`\n${formatBold(lexicon)}`);
    console.log("RESOURCE".padEnd(20) + "STATUS".padEnd(12) + "TYPE");
    console.log("-".repeat(60));

    for (const name of diff.added) {
      console.log(name.padEnd(20) + "added".padEnd(12) + (currentDigest.resources[name]?.type ?? ""));
    }
    for (const name of diff.changed) {
      console.log(name.padEnd(20) + "changed".padEnd(12) + (currentDigest.resources[name]?.type ?? ""));
    }
    for (const name of diff.removed) {
      console.log(name.padEnd(20) + "removed".padEnd(12) + (previousDigest?.resources[name]?.type ?? ""));
    }
    for (const name of diff.unchanged) {
      console.log(name.padEnd(20) + "unchanged".padEnd(12) + (currentDigest.resources[name]?.type ?? ""));
    }
  }

  return 0;
}

interface LiveDiffArgs {
  environment: string;
  lexicons: string[];
  plugins: ObservationLexicon[];
  buildResult: BuildResult;
  /** Emit machine-readable JSON on stdout instead of the human report (#852). */
  json: boolean;
  /** Deployed stack name for a multi-stack project (#932); scopes the live
   * observation (which CloudFormation stack to query) and the snapshot read. */
  stack?: string;
  /** Component projects deploy one CFN stack per component; observe them all and
   * union (the same fix graph/plan use), else every deployed resource reads as
   * "missing". Empty → the single-stack observe path. */
  componentStacks?: string[];
  /** Accepted-deviation baseline for this environment (#1014), or null when none is recorded. */
  baseline: ObservationBaseline | null;
  /** `--update-baseline`: accept everything the deep pass reports this run. */
  updateBaseline?: boolean;
}

interface LiveDiffOutcome {
  byLexicon: Record<
    string,
    {
      resources?: LiveDiffResult;
      observed?: Record<string, ResourceMetadata>;
      /** Declared entities the lexicon could not read (#1089), keyed by name. */
      unobserved?: Record<string, UnobservedEntity>;
      /** Property-level drift (#1014), present only for lexicons with a deep reader. */
      deep?: DeepDiffResult;
      artifacts?: LiveArtifactDiffResult;
    }
  >;
  totalDrift: number;
  /** Declared entities nobody could read. Not drift — a hole in the report. */
  totalUnobserved: number;
  totalLexiconsChecked: number;
  /** Deviations `--update-baseline` should record, per lexicon. */
  toAccept: Record<string, DeviationToAccept[]>;
}

/**
 * Read one lexicon's live resources, resolving the observation tri-state
 * (#1089) for every declared entity: present, confirmed-absent, or not
 * observed with a reason.
 *
 * Two behaviours the old inline call sites did not have. A throw no longer
 * skips the lexicon — every entity it was asked about comes back
 * NOT-OBSERVED (`read-failed`), so a failed read shows up in the plan instead
 * of vanishing from it. And a multi-stack read merges with
 * present > not-observed > absent, so one unreadable stack cannot un-observe a
 * resource another stack returned.
 */
async function observeLexicon(
  plugin: ObservationLexicon,
  opts: {
    environment: string;
    buildOutput: string;
    declared: Set<string>;
    entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
    stack?: string;
    componentStacks?: string[];
    owned?: boolean;
  },
): Promise<NormalizedObservation> {
  const entityNames = Array.from(opts.declared);
  const base = {
    environment: opts.environment,
    buildOutput: opts.buildOutput,
    entityNames,
    entities: opts.entities,
    ...(opts.owned !== undefined ? { owned: opts.owned } : {}),
  };
  try {
    if (opts.componentStacks && opts.componentStacks.length > 0) {
      const parts: NormalizedObservation[] = [];
      for (const stack of opts.componentStacks) {
        parts.push(normalizeObservation(await plugin.describeResources!({ ...base, stack })));
      }
      return mergeObservations(parts);
    }
    return normalizeObservation(
      await plugin.describeResources!({ ...base, ...(opts.stack ? { stack: opts.stack } : {}) }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(formatError({
      message: `${plugin.name}: describeResources failed — ${message} (reporting ${entityNames.length} declared entity(ies) as not observed, not as absent)`,
    }));
    return {
      resources: {},
      unobserved: unobservedAll(entityNames, "read-failed", message, opts.entities),
    };
  }
}

/** Diff current build vs live cloud for one stack. Renders the human report
 * inline; returns per-lexicon results so the caller emits the aggregate `--json`
 * once (single-stack keeps the original shape; multi-stack nests under `stacks`). */
async function runLifecycleDiffLive(args: LiveDiffArgs): Promise<LiveDiffOutcome> {
  let totalDrift = 0;
  let totalUnobserved = 0;
  let totalLexiconsChecked = 0;
  const byLexicon: LiveDiffOutcome["byLexicon"] = {};
  const toAccept: Record<string, DeviationToAccept[]> = {};
  if (!args.json && args.stack) console.log(`\n${formatBold(`■ stack ${args.stack}`)}`);

  for (const lexiconName of args.lexicons) {
    const plugin = args.plugins.find((p) => p.name === lexiconName);
    if (!plugin) continue;

    if (!plugin.describeResources && !plugin.listArtifacts) {
      console.error(formatWarning({
        message: `${lexiconName}: lexicon does not implement describeResources or listArtifacts — skipping (use without --live for digest diff)`,
      }));
      continue;
    }

    // Build per-lexicon entity index
    const declared = new Set<string>();
    const entities = new Map<string, { entityType: string; props: Record<string, unknown> }>();
    for (const [name, entity] of args.buildResult.entities) {
      if (entity.lexicon === lexiconName) {
        declared.add(name);
        entities.set(name, {
          entityType: entity.entityType,
          props: ("props" in entity && entity.props != null
            ? entity.props
            : {}) as Record<string, unknown>,
        });
      }
    }

    const rawOutput = args.buildResult.outputs.get(lexiconName);
    const buildOutput =
      rawOutput === undefined
        ? ""
        : typeof rawOutput === "string"
          ? rawOutput
          : (rawOutput as SerializerResult).primary;

    // Read previous snapshot once; both flows pull what they need.
    let prevSnapshot: LifecycleSnapshot | undefined;
    const content = await readSnapshot(args.environment, snapshotStorageKey(lexiconName, args.stack));
    if (content) prevSnapshot = JSON.parse(content);

    let lexiconChecked = false;

    // ── Resources path (entity-keyed) ──────────────────────────────────────
    if (plugin.describeResources) {
      const observed = await observeLexicon(plugin, {
        environment: args.environment,
        buildOutput,
        declared,
        entities,
        stack: args.stack,
        componentStacks: args.componentStacks,
      });
      const observedNow = observed.resources;
      const observedThen = prevSnapshot?.resources;
      const diff = diffLive({ declared, observedNow, observedThen, unobserved: observed.unobserved });
      // Unobserved entities are deliberately NOT drift: a hole in the read is
      // not a change in the cloud. They are reported separately (#1089) so a
      // "no drift detected" line can never be built on top of a failed read.
      totalDrift += diff.driftedSinceSnapshot.length + diff.missing.length + diff.orphan.length + diff.disappeared.length;
      totalUnobserved += diff.unobserved.length;
      if (args.json) {
        const entry = (byLexicon[lexiconName] ??= {});
        entry.resources = diff;
        entry.observed = observedNow; // live state (#862) — status/attributes per resource
        if (Object.keys(observed.unobserved).length > 0) entry.unobserved = observed.unobserved;
      } else renderLiveDiff(lexiconName, args.environment, diff);
      lexiconChecked = true;

      // ── Deep path (property-level, #1014) ───────────────────────────────
      // Gated purely on the capability: a lexicon without a deep reader is
      // completely unaffected, including its output.
      if (plugin.observeResourcesDeep) {
        const deep = await deepDiffForLexicon(plugin, {
          environment: args.environment,
          buildOutput,
          entities,
          stack: args.stack,
          componentStacks: args.componentStacks,
          baseline: baselineForLexicon(args.baseline, lexiconName),
        });
        totalDrift += countPropertyDrift(deep);
        // Only count a deep hole for an entity the thin read *did* resolve —
        // otherwise one unreadable entity is counted twice.
        totalUnobserved += deep.unobserved.filter((u) => !observed.unobserved[u.name]).length;
        if (args.updateBaseline) toAccept[lexiconName] = deviationsToAccept(deep);
        if (args.json) (byLexicon[lexiconName] ??= {}).deep = deep;
        else renderDeepDiff(lexiconName, deep);
      }
    }

    // ── Artifacts path (context-keyed) ─────────────────────────────────────
    if (plugin.listArtifacts) {
      let observedNow: Record<string, ArtifactMetadata>;
      try {
        observedNow = await plugin.listArtifacts({ environment: args.environment, entities, stack: args.stack });
      } catch (err) {
        console.error(formatError({
          message: `${lexiconName}: listArtifacts failed — ${err instanceof Error ? err.message : String(err)}`,
        }));
        continue;
      }
      const observedThen = prevSnapshot?.artifacts;
      const adiff = diffLiveArtifacts({ observedNow, observedThen });
      totalDrift += adiff.added.length + adiff.removed.length + adiff.changed.length;
      if (args.json) (byLexicon[lexiconName] ??= {}).artifacts = adiff;
      else renderLiveArtifactDiff(lexiconName, args.environment, adiff);
      lexiconChecked = true;
    }

    if (lexiconChecked) totalLexiconsChecked++;
  }

  return { byLexicon, totalDrift, totalUnobserved, totalLexiconsChecked, toAccept };
}

/**
 * Everything a deep diff reported this run, as deviations to record accepted.
 * `--update-baseline` accepts what was *reported*, never what was already
 * suppressed — re-accepting an unchanged suppression would rewrite its
 * `recordedAt` on every run and turn the baseline into a churn file.
 */
function deviationsToAccept(deep: DeepDiffResult): DeviationToAccept[] {
  const out: DeviationToAccept[] = [];
  for (const entity of deep.drifted) {
    for (const change of entity.changes) {
      // Only a value that is actually live can be accepted: `absent` means the
      // cloud does not carry the declared property, which is a finding to fix
      // in source or in the cloud, not a value to bless.
      if (!("live" in change)) continue;
      out.push({ entity: entity.name, type: entity.type, path: change.path, value: change.live });
    }
  }
  return out;
}

/** Property-level drift report (#1014). Silent when a lexicon's deep read found nothing to say. */
function renderDeepDiff(lexiconName: string, deep: DeepDiffResult): void {
  const drift = countPropertyDrift(deep);
  if (
    drift === 0 &&
    deep.accepted.length === 0 &&
    deep.unobserved.length === 0 &&
    deep.undeclaredEntities.length === 0
  ) {
    return;
  }

  const acceptedCount = deep.accepted.reduce((n, e) => n + e.changes.length, 0);
  console.log(`\n${formatBold(`${lexiconName} (properties)`)}`);
  console.log(
    `${drift} property drift across ${deep.drifted.length} resource(s), ` +
      `${acceptedCount} accepted, ${deep.unchanged.length} unchanged` +
      (deep.unobserved.length > 0 ? `, ${deep.unobserved.length} unobserved` : ""),
  );
  console.log("-".repeat(80));

  if (deep.unobserved.length > 0) {
    console.log(formatBold("\nPROPERTIES UNOBSERVED (declared; the deep read could not look):"));
    for (const u of deep.unobserved) console.log(`  ? ${formatUnobserved(u.name, u)}`);
  }
  if (deep.drifted.length > 0) {
    console.log(formatBold("\nPROPERTY DRIFT (declared vs live; baseline shown where one exists):"));
    for (const entity of deep.drifted) {
      console.log(`  - ${entity.name} (${entity.type})`);
      for (const change of entity.changes) {
        const declared = "declared" in change ? formatValue(change.declared) : "<undeclared>";
        const live = "live" in change ? formatValue(change.live) : "<absent>";
        const baseline = "baseline" in change ? ` [accepted: ${formatValue(change.baseline)}]` : "";
        console.log(`      ${change.path}: ${declared} → ${live}${baseline}`);
      }
    }
  }
  if (deep.undeclaredEntities.length > 0) {
    console.log(formatBold("\nUNDECLARED (read deeply, never declared in source):"));
    for (const name of deep.undeclaredEntities) console.log(`  - ${name}`);
  }
  if (acceptedCount > 0) {
    console.log(formatBold("\nACCEPTED (in the baseline; not drift):"));
    for (const entity of deep.accepted) {
      console.log(`  - ${entity.name}: ${entity.changes.map((c) => c.path).join(", ")}`);
    }
  }
}

function renderLiveDiff(lexiconName: string, environment: string, diff: LiveDiffResult): void {
  const counts =
    `${diff.missing.length} missing, ${diff.orphan.length} orphan, ` +
    `${diff.disappeared.length} disappeared, ${diff.newlyObserved.length} newly observed, ` +
    `${diff.driftedSinceSnapshot.length} drifted, ${diff.unchanged.length} unchanged` +
    (diff.runtimeChildren.length > 0 ? `, ${diff.runtimeChildren.length} runtime` : "") +
    (diff.unobserved.length > 0 ? `, ${diff.unobserved.length} unobserved` : "");

  console.log(`\n${formatBold(lexiconName)} — environment: ${environment}`);
  console.log(counts);
  console.log("-".repeat(80));

  if (diff.unobserved.length > 0) {
    console.log(formatBold("\nUNOBSERVED (declared; chant could not read live state — status unknown):"));
    for (const u of diff.unobserved) {
      console.log(`  ? ${formatUnobserved(u.name, u)}`);
    }
  }
  if (diff.missing.length > 0) {
    console.log(formatBold("\nMISSING (declared, provider reports not in cloud):"));
    for (const name of diff.missing) console.log(`  - ${name}`);
  }
  if (diff.orphan.length > 0) {
    console.log(formatBold("\nORPHAN (in cloud, not declared):"));
    for (const name of diff.orphan) console.log(`  - ${name}`);
  }
  if (diff.runtimeChildren.length > 0) {
    console.log(formatBold("\nRUNTIME (owned by a declared resource; not drift, not an orphan — #1077):"));
    for (const r of diff.runtimeChildren) console.log(`  - ${r.name} (${r.type}) — owned by ${r.owner}`);
  }
  if (diff.disappeared.length > 0) {
    console.log(formatBold("\nDISAPPEARED (in last snapshot, gone now):"));
    for (const name of diff.disappeared) console.log(`  - ${name}`);
  }
  if (diff.newlyObserved.length > 0) {
    console.log(formatBold("\nNEWLY OBSERVED (declared, observed, no prior snapshot):"));
    for (const name of diff.newlyObserved) console.log(`  - ${name}`);
  }
  if (diff.driftedSinceSnapshot.length > 0) {
    console.log(formatBold("\nDRIFTED (changed since last snapshot):"));
    for (const drift of diff.driftedSinceSnapshot) {
      console.log(`  - ${drift.name} (${drift.type})`);
      for (const change of drift.changes) {
        const oldStr = formatValue(change.oldValue);
        const newStr = formatValue(change.newValue);
        console.log(`      ${change.path}: ${oldStr} → ${newStr}`);
      }
    }
  }
}

function formatValue(v: unknown): string {
  if (v === undefined) return "<unset>";
  if (typeof v === "string") return v.length > 60 ? v.slice(0, 57) + "..." : v;
  const json = JSON.stringify(v);
  return json.length > 60 ? json.slice(0, 57) + "..." : json;
}

function renderLiveArtifactDiff(lexiconName: string, environment: string, diff: LiveArtifactDiffResult): void {
  // Skip emission entirely when there's nothing to show — keeps the output
  // clean for lexicons that only implement describeResources.
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0 && diff.unchanged.length === 0) {
    return;
  }

  const counts =
    `${diff.added.length} added, ${diff.removed.length} removed, ` +
    `${diff.changed.length} changed, ${diff.unchanged.length} unchanged`;

  console.log(`\n${formatBold(lexiconName)} (artifacts) — environment: ${environment}`);
  console.log(counts);
  console.log("-".repeat(80));

  if (diff.added.length > 0) {
    console.log(formatBold("\nARTIFACTS ADDED (in cloud now, not in last snapshot):"));
    for (const name of diff.added) console.log(`  - ${name}`);
  }
  if (diff.removed.length > 0) {
    console.log(formatBold("\nARTIFACTS REMOVED (in last snapshot, gone now):"));
    for (const name of diff.removed) console.log(`  - ${name}`);
  }
  if (diff.changed.length > 0) {
    console.log(formatBold("\nARTIFACTS CHANGED (metadata differs since last snapshot):"));
    for (const drift of diff.changed) {
      console.log(`  - ${drift.name} (${drift.type})`);
      for (const change of drift.changes) {
        const oldStr = formatValue(change.oldValue);
        const newStr = formatValue(change.newValue);
        console.log(`      ${change.path}: ${oldStr} → ${newStr}`);
      }
    }
  }
}

/**
 * chant lifecycle plan <environment> [lexicon]
 *
 * Promote the live diff to a typed, read-only change set: per-entity
 * create / update / delete / adopt / noop / unobserved. Strictly read-only —
 * never mutates, never deploys. Deletes are never proposed without ownership
 * data (added in #121); an undeclared live resource is `adopt`; a declared
 * entity chant could not read is `unobserved` and gets no proposal at all
 * (#1089) — a create is only ever proposed against a confirmed absence.
 */
export async function runLifecyclePlan(ctx: CommandContext): Promise<number> {
  const { args, plugins, serializers } = ctx;
  const environment = args.extraPositional;
  const lexiconFilter = args.extraPositional2;

  if (!environment) {
    console.error(formatError({ message: "Environment is required: chant lifecycle plan <environment> [lexicon]" }));
    return 1;
  }

  const targetSerializers = lexiconFilter
    ? plugins.filter((p) => p.name === lexiconFilter).map((p) => p.serializer)
    : serializers;

  const { config } = await loadChantConfig(resolve("."));
  const buildResult = await build(resolveBuildRoot(args, config), targetSerializers);
  if (buildResult.errors.length > 0) {
    console.error(formatError({ message: "Build failed — fix errors before planning" }));
    return 1;
  }

  await fetchLifecycle();

  const lexicons = lexiconFilter ? [lexiconFilter] : Array.from(buildResult.manifest.lexicons);

  // Multi-stack component projects deploy one CFN stack per component, so the
  // single-stack-per-env observe below would see nothing live and plan every
  // resource as "create". Resolve each component's cfn-deploy stack(s) and
  // observe them all — the same fix runGraphLive uses (graph.ts). Empty for a
  // single-stack project → the original single-call path is kept.
  let componentStacks: string[] = [];
  try {
    const disc = await discoverComponents(resolveBuildRoot(args, config), { sandbox: args.sandbox });
    const set = new Set<string>();
    for (const { component } of disc.components.values()) for (const s of cfnDeployStacks(component.deploy)) set.add(s);
    componentStacks = [...set];
  } catch {
    // no components / discovery failed → single-stack path
  }

  const merged: ChangeSet = { env: environment, entries: [] };
  let checked = 0;

  // #1166 — same self-sufficiency as `chant graph --live`: an environment can
  // declare its own endpoint, applied here unless the ambient shell already
  // set it. `chant lifecycle plan` is always a live read (no `--live` flag of
  // its own), so this applies unconditionally.
  const endpointResult = applyLiveEndpoint(config.environments, environment, lexicons);
  if (endpointResult.notice) console.error(formatWarning({ message: endpointResult.notice }));

  try {
    for (const lexiconName of lexicons) {
      const plugin = plugins.find((p) => p.name === lexiconName);
      if (!plugin) continue;
      if (!plugin.describeResources) {
        // Plan is entity-keyed; artifact-only lexicons have no declared axis.
        if (!args.json) {
          console.error(formatWarning({
            message: `${lexiconName}: lexicon does not implement describeResources — skipping (no declared axis to plan against)`,
          }));
        }
        continue;
      }

      const declared = new Set<string>();
      const entities = new Map<string, { entityType: string; props: Record<string, unknown> }>();
      for (const [name, entity] of buildResult.entities) {
        if (entity.lexicon === lexiconName) {
          declared.add(name);
          entities.set(name, {
            entityType: entity.entityType,
            props: ("props" in entity && entity.props != null ? entity.props : {}) as Record<string, unknown>,
          });
        }
      }

      const rawOutput = buildResult.outputs.get(lexiconName);
      const buildOutput =
        rawOutput === undefined
          ? ""
          : typeof rawOutput === "string"
            ? rawOutput
            : (rawOutput as SerializerResult).primary;

      const observed = await observeLexicon(plugin, {
        environment,
        buildOutput,
        declared,
        entities,
        componentStacks,
        owned: args.owned,
      });

      const content = await readSnapshot(environment, lexiconName);
      const observedThen = content ? (JSON.parse(content) as LifecycleSnapshot).resources : undefined;

      const cs = buildChangeSet(environment, {
        declared,
        observedNow: observed.resources,
        observedThen,
        unobserved: observed.unobserved,
      });
      merged.entries.push(...cs.entries);
      checked++;
    }
  } finally {
    endpointResult.restore();
  }

  if (checked === 0) {
    console.error(formatWarning({
      message: "No lexicons implement describeResources — nothing to plan",
    }));
    return 1;
  }

  merged.entries.sort((a, b) => a.name.localeCompare(b.name));

  // Say it on stderr too, so `--json` and `--report gitlab-mr` consumers (whose
  // shapes have no room for it) still learn the plan has a hole (#1089).
  const unobservedCount = summarize(merged).unobserved;
  if (unobservedCount > 0) {
    console.error(formatWarning({
      message: `${unobservedCount} declared entity(ies) could not be observed — no create/update/delete is proposed for them. This plan is incomplete, not clean.`,
    }));
  }

  // `--report gitlab-mr` emits the GitLab MR plan-widget artifact instead of the
  // human render. Write it to a file (`tfplan.json`) in CI and declare it as
  // `artifacts:reports:terraform` to light up the merge-request widget.
  if (args.reportFile === "gitlab-mr") {
    console.log(JSON.stringify(gitlabMrReport(merged)));
    return 0;
  }

  if (args.json) {
    console.log(JSON.stringify(merged, null, 2));
  } else {
    console.log(renderChangeSet(merged));
  }

  return 0;
}

/**
 * chant lifecycle log [environment]
 */
export async function runLifecycleLog(ctx: CommandContext): Promise<number> {
  const environment = ctx.args.extraPositional;

  await fetchLifecycle();

  const entries = await listSnapshots({ environment });
  if (entries.length === 0) {
    console.error(formatError({ message: "No state snapshots found" }));
    return 1;
  }

  for (const entry of entries) {
    const date = entry.date.split("T")[0];
    console.log(`${entry.commit.slice(0, 7)}  ${date}  ${entry.message}`);
  }

  return 0;
}

/**
 * Fallback for unknown state subcommands.
 */
export async function runLifecycleUnknown(ctx: CommandContext): Promise<number> {
  console.error(formatError({
    message: `Unknown state subcommand: ${ctx.args.extraPositional ?? ctx.args.path}`,
    hint: "Available: chant lifecycle snapshot, chant lifecycle show, chant lifecycle diff, chant lifecycle plan, chant lifecycle log",
  }));
  return 1;
}

function printSnapshotTable(snapshot: LifecycleSnapshot): void {
  console.log("RESOURCE".padEnd(20) + "TYPE".padEnd(28) + "PHYSICAL ID".padEnd(44) + "STATUS");
  console.log("-".repeat(100));

  for (const [name, meta] of Object.entries(snapshot.resources)) {
    const physicalId = meta.physicalId ?? "";
    const truncId = physicalId.length > 40 ? physicalId.slice(0, 37) + "..." : physicalId;
    console.log(
      name.padEnd(20) +
      meta.type.padEnd(28) +
      truncId.padEnd(44) +
      meta.status
    );
  }
}

/**
 * chant lifecycle affected --base <ref> [--head <ref>] [--include-dependents] [--json]
 *
 * Read-only: report which stacks a change affects (directly-changed via artifact
 * diff, dependents via the cross-stack graph, external-input as indeterminate).
 * Returns the set; fanning plan/apply over it is an Op the user composes.
 */
export async function runLifecycleAffected(ctx: CommandContext): Promise<number> {
  const { args, plugins } = ctx;
  if (!args.base) {
    console.error(formatError({
      message: "Base ref is required: chant lifecycle affected --base <ref> [--head <ref>] [--include-dependents]",
    }));
    return 1;
  }

  const { config } = await loadChantConfig(resolve("."));
  const projectPath = resolveBuildRoot(args, config);

  let result;
  try {
    result = await affectedStacks({
      projectPath,
      serializers: plugins.map((p) => p.serializer),
      baseRef: args.base,
      headRef: args.head,
      includeDependents: args.includeDependents,
    });
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (result.changed.length === 0 && result.dependents.length === 0) {
    console.error(formatSuccess("No stacks affected"));
  } else {
    console.log(formatBold("Directly changed:"));
    console.log(result.changed.length ? result.changed.map((s) => `  ${s}`).join("\n") : "  (none)");
    if (args.includeDependents) {
      console.log(formatBold("\nDependents (consume a changed stack):"));
      console.log(result.dependents.length ? result.dependents.map((s) => `  ${s}`).join("\n") : "  (none)");
    }
  }
  if (result.indeterminate.length > 0) {
    console.error(formatWarning({
      message: `External-input stacks — cannot confirm from source: ${result.indeterminate.join(", ")}`,
    }));
  }
  return 0;
}
