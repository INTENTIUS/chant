import { resolve } from "node:path";
import { build } from "../../build";
import { takeSnapshot } from "../../state/snapshot";
import { readSnapshot, readEnvironmentSnapshots, listSnapshots, fetchState } from "../../state/git";
import { computeBuildDigest, diffDigests } from "../../state/digest";
import { loadChantConfig } from "../../config";
import { formatError, formatWarning, formatSuccess, formatBold } from "../format";
import type { CommandContext } from "../registry";
import type { StateSnapshot } from "../../state/types";

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

  const result = await takeSnapshot(environment, pluginsWithDescribe, buildResult);

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

  // Build to get current digest
  const projectPath = resolve(".");
  const buildResult = await build(projectPath, targetSerializers);
  if (buildResult.errors.length > 0) {
    console.error(formatError({ message: "Build failed — fix errors before diffing" }));
    return 1;
  }

  const currentDigest = computeBuildDigest(buildResult);

  // Fetch and read previous snapshot
  await fetchState();

  const lexicons = lexiconFilter
    ? [lexiconFilter]
    : Array.from(buildResult.manifest.lexicons);

  for (const lexicon of lexicons) {
    const content = await readSnapshot(environment, lexicon);
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
