import { resolve } from "node:path";
import { build } from "../../build";
import { takeSnapshot } from "../../state/snapshot";
import { readSnapshot, readEnvironmentSnapshots, listSnapshots, fetchState, StaleStateBranchError } from "../../state/git";
import { computeBuildDigest, diffDigests } from "../../state/digest";
import { diffLive, type LiveDiffResult } from "../../state/live-diff";
import { loadChantConfig } from "../../config";
import { formatError, formatWarning, formatSuccess, formatBold } from "../format";
import type { CommandContext } from "../registry";
import type { StateSnapshot } from "../../state/types";
import type { SerializerResult } from "../../serializer";
import type { LexiconPlugin, ResourceMetadata } from "../../lexicon";
import type { BuildResult } from "../../build";

/**
 * chant state snapshot <environment> [lexicon]
 */
export async function runStateSnapshot(ctx: CommandContext): Promise<number> {
  const { args, plugins } = ctx;
  const environment = args.extraPositional;
  const lexiconFilter = args.extraPositional2;

  if (!environment) {
    console.error(formatError({ message: "Environment is required: chant state snapshot <environment> [lexicon]" }));
    return 1;
  }

  // Validate environment against config
  const projectPath = resolve(".");
  const { config } = await loadChantConfig(projectPath);
  if (config.environments && !config.environments.includes(environment)) {
    console.error(formatError({
      message: `Unknown environment "${environment}"`,
      hint: `Defined environments: ${config.environments.join(", ")}`,
    }));
    return 1;
  }

  // Filter plugins if lexicon specified
  const targetPlugins = lexiconFilter
    ? plugins.filter((p) => p.name === lexiconFilter)
    : plugins;
  const targetSerializers = targetPlugins.map((p) => p.serializer);

  // Build first to get entity names and build output
  const buildResult = await build(projectPath, targetSerializers);
  if (buildResult.errors.length > 0) {
    console.error(formatError({ message: "Build failed — fix errors before taking a snapshot" }));
    return 1;
  }

  const pluginsWithDescribe = targetPlugins.filter((p) => p.describeResources);
  if (pluginsWithDescribe.length === 0) {
    console.error(formatError({
      message: "No plugins implement describeResources",
      hint: lexiconFilter ? `Lexicon "${lexiconFilter}" does not support state snapshots` : undefined,
    }));
    return 1;
  }

  let result;
  try {
    result = await takeSnapshot(environment, pluginsWithDescribe, buildResult);
  } catch (err) {
    if (err instanceof StaleStateBranchError) {
      console.error(formatError({
        message: `Another snapshot completed for chant/state after this run started (env: ${environment}).`,
        hint: `Pull and retry: \`git fetch origin ${"chant/state"}:${"chant/state"}\` && \`chant state snapshot ${environment}\`.`,
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
    const counts = result.snapshots
      .map((s) => `${s.lexicon}(${Object.keys(s.resources).length})`)
      .join(" ");
    console.error(formatSuccess(`Snapshot saved to chant/state (${counts})`));
  }

  return result.errors.length > 0 && result.snapshots.length === 0 ? 1 : 0;
}

/**
 * chant state show <environment> [lexicon]
 */
export async function runStateShow(ctx: CommandContext): Promise<number> {
  const environment = ctx.args.extraPositional;
  const lexiconFilter = ctx.args.extraPositional2;

  if (!environment) {
    console.error(formatError({ message: "Environment is required: chant state show <environment> [lexicon]" }));
    return 1;
  }

  // Fetch from remote first
  await fetchState();

  if (lexiconFilter) {
    const content = await readSnapshot(environment, lexiconFilter);
    if (!content) {
      console.error(formatError({ message: `No snapshot found for ${environment}/${lexiconFilter}` }));
      return 1;
    }

    const snapshot: StateSnapshot = JSON.parse(content);
    printSnapshotTable(snapshot);
  } else {
    const snapshots = await readEnvironmentSnapshots(environment);
    if (snapshots.size === 0) {
      console.error(formatError({ message: `No snapshots found for environment "${environment}"` }));
      return 1;
    }

    for (const [lexicon, content] of snapshots) {
      const snapshot: StateSnapshot = JSON.parse(content);
      console.log(`\n${formatBold(`${environment}/${lexicon}`)} — ${Object.keys(snapshot.resources).length} resources — ${snapshot.timestamp}`);
      printSnapshotTable(snapshot);
    }
  }

  return 0;
}

/**
 * chant state diff <environment> [lexicon]
 */
export async function runStateDiff(ctx: CommandContext): Promise<number> {
  const { args, plugins, serializers } = ctx;
  const environment = args.extraPositional;
  const lexiconFilter = args.extraPositional2;

  if (!environment) {
    console.error(formatError({ message: "Environment is required: chant state diff <environment> [lexicon]" }));
    return 1;
  }

  // Filter serializers to target lexicon before building
  const targetSerializers = lexiconFilter
    ? plugins.filter((p) => p.name === lexiconFilter).map((p) => p.serializer)
    : serializers;

  // Build to get current state
  const projectPath = resolve(".");
  const buildResult = await build(projectPath, targetSerializers);
  if (buildResult.errors.length > 0) {
    console.error(formatError({ message: "Build failed — fix errors before diffing" }));
    return 1;
  }

  // Fetch and read previous snapshot
  await fetchState();

  const lexicons = lexiconFilter
    ? [lexiconFilter]
    : Array.from(buildResult.manifest.lexicons);

  if (args.live) {
    return runStateDiffLive({ environment, lexicons, plugins, buildResult });
  }

  return runStateDiffDigest({ environment, lexicons, buildResult });
}

interface DigestDiffArgs {
  environment: string;
  lexicons: string[];
  buildResult: BuildResult;
}

async function runStateDiffDigest(args: DigestDiffArgs): Promise<number> {
  const currentDigest = computeBuildDigest(args.buildResult);

  for (const lexicon of args.lexicons) {
    const content = await readSnapshot(args.environment, lexicon);
    let previousDigest = undefined;
    if (content) {
      const snapshot: StateSnapshot = JSON.parse(content);
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
  plugins: LexiconPlugin[];
  buildResult: BuildResult;
}

async function runStateDiffLive(args: LiveDiffArgs): Promise<number> {
  let totalDrift = 0;
  let totalLexiconsChecked = 0;

  for (const lexiconName of args.lexicons) {
    const plugin = args.plugins.find((p) => p.name === lexiconName);
    if (!plugin) continue;

    if (!plugin.describeResources) {
      console.error(formatWarning({
        message: `${lexiconName}: lexicon does not implement describeResources — skipping (use without --live for digest diff)`,
      }));
      continue;
    }

    // Resources declared in this lexicon's slice of the build
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

    let observedNow: Record<string, ResourceMetadata>;
    try {
      observedNow = await plugin.describeResources({
        environment: args.environment,
        buildOutput,
        entityNames: Array.from(declared),
        entities,
      });
    } catch (err) {
      console.error(formatError({
        message: `${lexiconName}: describeResources failed — ${err instanceof Error ? err.message : String(err)}`,
      }));
      continue;
    }

    let observedThen: Record<string, ResourceMetadata> | undefined;
    const content = await readSnapshot(args.environment, lexiconName);
    if (content) {
      const snapshot: StateSnapshot = JSON.parse(content);
      observedThen = snapshot.resources;
    }

    const diff = diffLive({ declared, observedNow, observedThen });
    totalLexiconsChecked++;
    totalDrift += diff.driftedSinceSnapshot.length + diff.missing.length + diff.orphan.length + diff.disappeared.length;

    renderLiveDiff(lexiconName, args.environment, diff);
  }

  if (totalLexiconsChecked === 0) {
    console.error(formatWarning({
      message: "No lexicons implement describeResources — nothing to diff in --live mode",
    }));
    return 1;
  }

  if (totalDrift === 0) {
    console.error(formatSuccess(`No drift detected across ${totalLexiconsChecked} lexicon(s)`));
  }

  return 0;
}

function renderLiveDiff(lexiconName: string, environment: string, diff: LiveDiffResult): void {
  const counts =
    `${diff.missing.length} missing, ${diff.orphan.length} orphan, ` +
    `${diff.disappeared.length} disappeared, ${diff.newlyObserved.length} newly observed, ` +
    `${diff.driftedSinceSnapshot.length} drifted, ${diff.unchanged.length} unchanged`;

  console.log(`\n${formatBold(lexiconName)} — environment: ${environment}`);
  console.log(counts);
  console.log("-".repeat(80));

  if (diff.missing.length > 0) {
    console.log(formatBold("\nMISSING (declared, not in cloud):"));
    for (const name of diff.missing) console.log(`  - ${name}`);
  }
  if (diff.orphan.length > 0) {
    console.log(formatBold("\nORPHAN (in cloud, not declared):"));
    for (const name of diff.orphan) console.log(`  - ${name}`);
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

/**
 * chant state log [environment]
 */
export async function runStateLog(ctx: CommandContext): Promise<number> {
  const environment = ctx.args.extraPositional;

  await fetchState();

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
export async function runStateUnknown(ctx: CommandContext): Promise<number> {
  console.error(formatError({
    message: `Unknown state subcommand: ${ctx.args.extraPositional ?? ctx.args.path}`,
    hint: "Available: chant state snapshot, chant state show, chant state diff, chant state log",
  }));
  return 1;
}

function printSnapshotTable(snapshot: StateSnapshot): void {
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
