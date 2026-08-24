import { resolve } from "node:path";
import { commandBuildParams } from "../build-params-cli";
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
import { loadChantConfig, environmentNames, matchesDeclaredEnvironment, resolveOwnershipStack } from "../../config";
import { unknownEnvError, isProdLikeEnvironment } from "../../env";
import { planTeardown, executeTeardown, type TeardownPlan, type TeardownReport } from "../../lifecycle/teardown";
import { collectBuildRootContributors } from "../plugins";
import { applyLiveEndpoint } from "../../live-endpoint";
import { isResourceDeclarable } from "../../declarable";
import { collectEffectReceipts } from "../../effect-receipt";
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
  // This invocation's parameters, so the declared side of the comparison is the estate
  // the caller asked for rather than the parameter defaults (#1483).
  const declaredParams = await commandBuildParams(config.buildParams, args);
  if (!declaredParams) return 1;
  const declaredEnvNames = environmentNames(config.environments);
  if (declaredEnvNames && !matchesDeclaredEnvironment(config.environments, environment)) {
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
  const endpointResult = applyLiveEndpoint(config.environments, environment, observingPlugins);
  if (endpointResult.notice) console.error(formatWarning({ message: endpointResult.notice }));

  // Build every stack first, so the ambient scan (#1278) can be bounded by the
  // kinds the PROJECT manages rather than the ones this stack happens to
  // declare. "Which of my security groups are unused" is a question about the
  // estate; a region whose stack declares no security group still has a default
  // one, and scoping the bound per stack silently drops it.
  const built: Array<{ target: (typeof targets)[number]; buildResult: Awaited<ReturnType<typeof build>> }> = [];
  const buildRoots = collectBuildRootContributors(targetPlugins, config as unknown as Record<string, unknown>, projectPath);
  for (const target of targets) {
    const label = target.stack ? `stack "${target.stack}"` : "project";
    const buildResult = await build(target.root, targetSerializers, undefined, { buildParams: declaredParams, buildRoots });
    if (buildResult.errors.length > 0) {
      console.error(formatError({ message: `Build failed for ${label} — fix errors before taking a snapshot` }));
      anyHardError = true;
      continue;
    }
    built.push({ target, buildResult });
  }
  const projectKinds = [
    ...new Set(built.flatMap(({ buildResult }) => [...buildResult.entities.values()].map((e) => e.entityType))),
  ];

  try {
    for (const { target, buildResult } of built) {
      const label = target.stack ? `stack "${target.stack}"` : "project";

      let result;
      try {
        result = await takeSnapshot(environment, observingPlugins, buildResult, {
          stack: target.stack,
          region: target.region,
          deep: args.deep,
          ambient: args.ambient,
          ambientKinds: projectKinds,
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
      // Depth is stated, not inferred (#1267). An identity snapshot cannot
      // answer a property question, and a reader that assumes otherwise reads
      // "no properties recorded" as "no such properties".
      const depth = snapshot.depth ?? "identity";
      const depthNote =
        depth === "deep"
          ? ` — deep (${Object.keys(snapshot.properties ?? {}).length} property trees)`
          : " — identity only";
      console.log(`\n${formatBold(`${environment}/${lexicon}`)} — ${Object.keys(snapshot.resources).length} resources${depthNote} — ${snapshot.timestamp}`);
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
    const result = await rollbackToRevision({ ref, env: environment, sourceDir, cwd: resolve("."), dryRun: args.dryRun });
    if (result.noop) {
      console.error(formatSuccess(`${sourceDir} already matches ${ref} — nothing to roll back`));
      return 0;
    }
    if (args.dryRun) {
      // The delta on stdout, so it pipes and diffs like any other patch; the
      // summary on stderr, matching the PR path's split.
      process.stdout.write(result.diff ?? "");
      console.error(formatSuccess(`Rollback delta for ${ref} computed — no PR opened, nothing pushed`));
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
  // This invocation's parameters, so the declared side of the comparison is the estate
  // the caller asked for rather than the parameter defaults (#1483).
  const declaredParams = await commandBuildParams(config.buildParams, args);
  if (!declaredParams) return 1;
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
  // Effect receipts across every target's build (#1833) — `--update-baseline`
  // refuses to accept drift on them (the effect step is their only writer),
  // and recognition is marker-based so materialized lexicon rows are caught.
  const receiptEntities = new Set<string>();

  // #1166 — an environment can declare its own endpoint (a local emulator like
  // Floci), so `--live` is self-sufficient even when the ambient shell never
  // exported e.g. AWS_ENDPOINT_URL. Ambient always wins when it's already set.
  // Scoped to just the live reads below — restored in `finally`.
  const liveLexicons = args.live ? plugins.filter((p) => p.describeResources || p.listArtifacts) : [];
  const endpointResult = applyLiveEndpoint(config.environments, environment, liveLexicons);
  if (endpointResult.notice) console.error(formatWarning({ message: endpointResult.notice }));

  const diffBuildRoots = collectBuildRootContributors(plugins, config as unknown as Record<string, unknown>, resolve("."));

  try {
    for (const target of targets) {
      const buildResult = await build(target.root, targetSerializers, undefined, { buildParams: declaredParams, buildRoots: diffBuildRoots });
      if (buildResult.errors.length > 0) {
        const label = target.stack ? `stack "${target.stack}"` : "project";
        console.error(formatError({ message: `Build failed for ${label} — fix errors before diffing` }));
        anyBuildError = true;
        continue;
      }

      // The lexicons the diff walks. Keyed on the BUILT manifest — which is
      // right for the resource axis (a lexicon with no declared entities has
      // nothing to diff) but drops the artifact axis whole: artifacts are
      // context-keyed with no declared side at all (that is their defining
      // property), so an estate that uses helm purely as component deploy
      // steps builds zero helm entities and its releases were never listed —
      // `observedArtifacts` silently absent for exactly the estates behold#146
      // exists for (found live on kubemicrovm-ops, four releases invisible).
      // On the live path, artifact-capable configured lexicons join the walk;
      // their resource half stays gated on `describeResources` + declared
      // entities as before.
      const builtLexicons = Array.from(buildResult.manifest.lexicons);
      const artifactLexicons = args.live ? plugins.filter((p) => p.listArtifacts).map((p) => p.name) : [];
      const lexicons = lexiconFilter
        ? [lexiconFilter]
        : [...new Set([...builtLexicons, ...artifactLexicons])];

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
          region: target.region,
          componentStacks,
          baseline,
          updateBaseline: args.updateBaseline,
          ...(args.namespace ? { namespace: args.namespace } : {}),
        });
        totalDrift += r.totalDrift;
        totalUnobserved += r.totalUnobserved;
        totalChecked += r.totalLexiconsChecked;
        for (const [lexicon, deviations] of Object.entries(r.toAccept)) {
          (accepted[lexicon] ??= []).push(...deviations);
        }
        if (args.updateBaseline) {
          for (const name of collectEffectReceipts(buildResult.entities).keys()) receiptEntities.add(name);
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
      await recordAcceptedBaseline(environment, baseline, accepted, json, receiptEntities);
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
  receipts?: ReadonlySet<string>,
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
  try {
    // `acceptDeviations` throws on an effect-receipt deviation (#1833) —
    // inside the try so the refusal reaches the operator as a formatted
    // error, with no baseline written at all.
    let next = existing ?? emptyBaseline(environment);
    for (const [lexicon, deviations] of Object.entries(accepted)) {
      next = acceptDeviations(next, lexicon, deviations, { receipts });
    }
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
      message: `--update-baseline: baseline not updated — ${err instanceof Error ? err.message : String(err)}`,
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

    // chant #1442 — a lexicon bump can change emitted output with no source
    // change, so every resource above can read "unchanged" while the build is
    // not the same build. Printed under the table rather than as a row: no
    // resource's declaration moved, the thing that interpreted them did.
    for (const change of diff.lexiconVersionChanges) {
      const from = change.previous ?? "(absent)";
      const to = change.current ?? "(absent)";
      console.log(`\nlexicon ${change.lexicon}: ${from} → ${to}`);
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
  /** Region that stack is deployed in, from `stacks[].region` (#1264). Same
   * contract as snapshot (#1261): without it every stack is read against the
   * ambient region, so a multi-region estate reports its out-of-region stacks
   * as absent rather than unobserved. */
  region?: string;
  /** Component projects deploy one CFN stack per component; observe them all and
   * union (the same fix graph/plan use), else every deployed resource reads as
   * "missing". Empty → the single-stack observe path. */
  componentStacks?: string[];
  /** Accepted-deviation baseline for this environment (#1014), or null when none is recorded. */
  baseline: ObservationBaseline | null;
  /** `--update-baseline`: accept everything the deep pass reports this run. */
  updateBaseline?: boolean;
  /** `--namespace <ns>` (#1629): where to read entities that declare no
   * namespace of their own. */
  namespace?: string;
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
      /** What `listArtifacts` actually saw, keyed like `artifacts`' entries
       * (behold#146). The diff alone is snapshot-relative key lists — on a
       * first run everything is `added` with no metadata, so a consumer
       * painting artifact presence (a Helm release's status) had nothing to
       * read. Mirrors `observed` on the resources path. */
      observedArtifacts?: Record<string, ArtifactMetadata>;
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
    /** Region the stack is deployed in (#1264); the read targets it instead of
     * the ambient region. */
    region?: string;
    componentStacks?: string[];
    owned?: boolean;
    /** `--namespace <ns>` (#1629): where to read an entity that declares no
     * namespace of its own. A default, not a rewrite. */
    namespace?: string;
  },
): Promise<NormalizedObservation> {
  const entityNames = Array.from(opts.declared);
  const base = {
    environment: opts.environment,
    buildOutput: opts.buildOutput,
    entityNames,
    entities: opts.entities,
    ...(opts.region ? { region: opts.region } : {}),
    ...(opts.owned !== undefined ? { owned: opts.owned } : {}),
    ...(opts.namespace ? { namespace: opts.namespace } : {}),
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
      queried: {},
      notes: [],
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

    // Build per-lexicon entity index. Resource declarables only — outputs,
    // parameters and serializer directives have no live counterpart, and a
    // declared name the reader can never resolve reads as missing (see
    // lifecycle/observe.ts).
    const declared = new Set<string>();
    const entities = new Map<string, { entityType: string; props: Record<string, unknown> }>();
    for (const [name, entity] of args.buildResult.entities) {
      if (entity.lexicon === lexiconName && isResourceDeclarable(entity)) {
        declared.add(name);
        entities.set(name, {
          entityType: entity.entityType,
          props: (entity.props != null ? entity.props : {}) as Record<string, unknown>,
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
        region: args.region,
        componentStacks: args.componentStacks,
        ...(args.namespace ? { namespace: args.namespace } : {}),
      });
      const observedNow = observed.resources;
      const observedThen = prevSnapshot?.resources;
      const diff = diffLive({ declared, observedNow, observedThen, unobserved: observed.unobserved, queried: observed.queried });
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
          region: args.region,
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
      if (args.json) {
        const lex = (byLexicon[lexiconName] ??= {});
        lex.artifacts = adiff;
        // What was actually seen, not just how it moved (behold#146): the
        // metadata was in hand and dropped, leaving JSON consumers unable to
        // read an artifact's own status (a Helm release's "deployed").
        lex.observedArtifacts = observedNow;
      } else renderLiveArtifactDiff(lexiconName, args.environment, adiff);
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
    for (const name of diff.missing) {
      // The address the read actually went to (#1620) — the line between "not
      // there" and "looked in the wrong place" (a defaulted namespace, say).
      const queried = diff.queried?.[name];
      console.log(`  - ${name}${queried ? ` [queried ${queried}]` : ""}`);
    }
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
  // This invocation's parameters, so the declared side of the comparison is the estate
  // the caller asked for rather than the parameter defaults (#1483).
  const declaredParams = await commandBuildParams(config.buildParams, args);
  if (!declaredParams) return 1;
  const buildResult = await build(resolveBuildRoot(args, config), targetSerializers, undefined, {
    buildParams: declaredParams,
    buildRoots: collectBuildRootContributors(plugins, config as unknown as Record<string, unknown>, resolve(".")),
  });
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
  // Names here, plugins there: the endpoint vars come from each lexicon's own
  // emulator capability (#1345), so this needs the loaded plugin, not the name.
  const endpointResult = applyLiveEndpoint(
    config.environments,
    environment,
    lexicons.map((name) => plugins.find((p) => p.name === name)).filter((p) => p !== undefined),
  );
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
        if (entity.lexicon === lexiconName && isResourceDeclarable(entity)) {
          declared.add(name);
          entities.set(name, {
            entityType: entity.entityType,
            props: (entity.props != null ? entity.props : {}) as Record<string, unknown>,
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
        // A plan reading the wrong namespace proposes creates for resources
        // that are running (#1629) — the same override the live diff takes.
        ...(args.namespace ? { namespace: args.namespace } : {}),
      });

      const content = await readSnapshot(environment, lexiconName);
      const observedThen = content ? (JSON.parse(content) as LifecycleSnapshot).resources : undefined;

      const cs = buildChangeSet(environment, {
        declared,
        observedNow: observed.resources,
        observedThen,
        unobserved: observed.unobserved,
        // The resolved read address rides every entry, not just unobserved
        // ones — the diff path already passes it (#1620); plan lost it.
        queried: observed.queried,
      }, {
        // Attribution survives the flat merge below (#1674).
        lexicon: lexiconName,
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
 * chant lifecycle teardown <environment> (#1222).
 *
 * Enumerates what deleting the environment would remove: every live resource
 * carrying this project's ownership marker (managed-by + `ownership.stack`)
 * with the requested env identity. Stateless — live markers only, no build, no
 * snapshot. Without `--yes` nothing is deleted; with it the planned set is
 * executed per lexicon with one bounded retry pass over failures, and every
 * candidate's outcome is reported (deleted / failed / not-prunable / retained / skipped —
 * never silence). A production-like environment name additionally requires an
 * interactive confirmation, or `--confirm-prod` non-interactively.
 */
export async function runLifecycleTeardown(ctx: CommandContext): Promise<number> {
  const { args, plugins } = ctx;
  const environment = args.extraPositional;

  if (!environment) {
    console.error(formatError({ message: "Environment is required: chant lifecycle teardown <environment>" }));
    return 1;
  }

  const { config } = await loadChantConfig(resolve("."));

  // Refuse an env the project does not declare — a typo here is the difference
  // between tearing down `dev` and tearing down `prod`. Literal `environments`
  // entries only (#1221's pattern entries would extend this same check).
  const envErr = unknownEnvError(environment, config.environments);
  if (envErr) {
    console.error(formatError({ message: envErr }));
    return 1;
  }

  // Teardown selects on the ownership marker; a project that stamps none has
  // nothing to key on, and "delete what looks like mine" is not a fallback.
  const stack = resolveOwnershipStack(config);
  if (stack === undefined) {
    console.error(formatError({
      message: "This project declares no ownership.stack — teardown is marker-scoped and has nothing to select on",
      hint: 'Set `ownership: { stack: "<name>" }` in chant.config.ts and deploy, so resources carry the marker teardown keys on.',
    }));
    return 1;
  }

  // The prod guard (#1222): a production-like name never falls to `--yes`
  // alone. Interactive runs re-type the environment name; non-interactive
  // runs say `--confirm-prod` explicitly. Checked before any live read so a
  // refused teardown touches nothing at all.
  if (args.yes && isProdLikeEnvironment(environment) && !args.confirmProd) {
    if (!process.stdin.isTTY) {
      console.error(formatError({
        message: `"${environment}" looks like a production environment — --yes alone is not enough`,
        hint: "Re-run with --yes --confirm-prod to tear it down non-interactively.",
      }));
      return 1;
    }
    const confirmed = await promptProdTeardown(environment);
    if (!confirmed) {
      console.error(formatError({ message: "Confirmation did not match — nothing was deleted." }));
      return 1;
    }
  }

  // #1166 — teardown is always a live read (and with --yes, a live write), so
  // an environment's declared endpoint applies here too, unless the ambient
  // shell already set it.
  const readingPlugins = plugins.filter((p) => p.teardownOwned || p.describeResources || p.executeTeardown);
  const endpointResult = applyLiveEndpoint(config.environments, environment, readingPlugins);
  if (endpointResult.notice) console.error(formatWarning({ message: endpointResult.notice }));

  let plan: TeardownPlan;
  let report: TeardownReport | undefined;
  try {
    // A multi-stack project's declared stacks, for stack-shaped teardowns
    // (aws enumerates and deletes whole CloudFormation stacks). A single-stack
    // project passes nothing and the env-named default convention applies.
    const deployedStacks = (config.stacks ?? []).map((s) => ({
      name: s.name,
      ...(s.region ? { region: s.region } : {}),
    }));
    plan = await planTeardown({
      environment,
      stack,
      plugins,
      ...(deployedStacks.length > 0 ? { deployedStacks } : {}),
    });
    if (args.yes) {
      report = await executeTeardown({
        environment,
        stack,
        plugins,
        plan,
        ...(deployedStacks.length > 0 ? { deployedStacks } : {}),
      });
    }
  } finally {
    endpointResult.restore();
  }

  if (args.json) {
    console.log(JSON.stringify(report ?? plan, null, 2));
    return report && report.outcomes.some((o) => o.outcome === "failed") ? 1 : 0;
  }

  console.log(formatBold(
    args.yes
      ? `Teardown — environment: ${environment}, stack: ${stack}`
      : `Teardown plan — environment: ${environment}, stack: ${stack} (plan only — nothing is deleted)`,
  ));

  if (plan.entries.length === 0) {
    console.error(formatWarning({
      message: `No live resources carry the marker stack "${stack}" + env "${environment}" — nothing would be deleted.` +
        (plan.holes.length > 0
          ? " But this plan has holes (below) — parts of the estate could not be read, so \"nothing\" is a claim about what was readable, not about the environment."
          : " If this environment is deployed, check that its resources were stamped (ownership marking on, and the env identity resolved at build time)."),
    }));
  } else {
    console.log(`\n${plan.entries.length} resource(s) would be deleted:`);
    console.log("RESOURCE".padEnd(28) + "TYPE".padEnd(32) + "MARKER".padEnd(24) + "LEXICON");
    console.log("-".repeat(96));
    for (const entry of plan.entries) {
      console.log(
        entry.name.padEnd(28) +
        entry.type.padEnd(32) +
        `${entry.marker.stack}/${entry.marker.env}`.padEnd(24) +
        entry.lexicon,
      );
    }
  }

  // Holes are loud (#1089): an unreadable kind is unknown, not absent, and the
  // execution half must not treat this plan as the whole delete set.
  if (plan.holes.length > 0) {
    console.error(formatWarning({
      message: `${plan.holes.length} hole(s) — resources chant may own but could not read. This plan is incomplete, not clean.`,
    }));
    console.log(formatBold("\nHOLES (stamped kinds the read could not cover):"));
    for (const hole of plan.holes) {
      console.log(`  ? ${hole.lexicon}: ${hole.name}${hole.type ? ` (${hole.type})` : ""} — ${hole.reason}${hole.detail ? `: ${hole.detail}` : ""}`);
    }
  }

  if (plan.skipped.length > 0) {
    console.error(formatWarning({
      message: `Skipped (no teardown enumeration and no describeResources): ${plan.skipped.join(", ")} — those lexicons' resources are not in this plan.`,
    }));
  }

  if (!report) {
    console.error(formatWarning({ message: "Plan only — re-run with --yes to execute." }));
    return 0;
  }

  if (report.outcomes.length > 0) {
    console.log(formatBold("\nOutcomes:"));
    console.log("RESOURCE".padEnd(28) + "OUTCOME".padEnd(14) + "LEXICON".padEnd(12) + "DETAIL");
    console.log("-".repeat(96));
    for (const o of report.outcomes) {
      console.log(
        o.name.padEnd(28) +
        o.outcome.padEnd(14) +
        o.lexicon.padEnd(12) +
        (o.detail ?? "") +
        (o.retried ? " (after retry)" : ""),
      );
    }
  }

  const counts = { deleted: 0, failed: 0, "not-prunable": 0, retained: 0, skipped: 0 };
  for (const o of report.outcomes) counts[o.outcome]++;
  console.log(
    `\n${counts.deleted} deleted, ${counts.failed} failed, ${counts["not-prunable"]} not prunable, ` +
    `${counts.retained} retained, ${counts.skipped} skipped`,
  );

  if (report.unimplemented.length > 0) {
    console.error(formatWarning({
      message: `Not executed (no teardown execution in these lexicons yet): ${report.unimplemented.join(", ")} — their candidates are reported as skipped, not deleted.`,
    }));
  }
  if (counts.retained > 0) {
    console.error(formatWarning({
      message: `${counts.retained} resource(s) retained — owned by this env but deliberately kept (generated-once secrets are never swept). ` +
        `The environment is NOT clean while they exist; delete them explicitly (e.g. kubectl delete) if you mean to.`,
    }));
  }
  if (plan.holes.length > 0) {
    console.error(formatWarning({
      message: "This teardown ran over an incomplete plan (holes above) — the environment cannot be called clean.",
    }));
  }
  if (counts.failed > 0) {
    console.error(formatError({
      message: `${counts.failed} candidate(s) failed to delete after the retry pass — see the outcomes above.`,
    }));
    return 1;
  }

  return 0;
}

/**
 * The interactive half of the prod guard: the operator re-types the
 * environment name. Anything else — including EOF — refuses.
 */
async function promptProdTeardown(environment: string): Promise<boolean> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePrompt) => {
    rl.question(
      `"${environment}" looks like a production environment. Type the environment name to confirm teardown: `,
      (answer) => {
        resolvePrompt(answer.trim() === environment);
        rl.close();
      },
    );
    // EOF (Ctrl-D) closes the interface without answering — that is a refusal.
    rl.on("close", () => resolvePrompt(false));
  });
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
    hint: "Available: chant lifecycle snapshot, chant lifecycle show, chant lifecycle diff, chant lifecycle plan, chant lifecycle teardown, chant lifecycle log",
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
