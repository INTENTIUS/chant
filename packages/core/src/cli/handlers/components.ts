/**
 * `chant components` handlers — release ledger + status surface (#568, epic
 * #551 "Build & deploy observability").
 *
 * Two subcommands:
 *  - `chant components release record` — append one immutable release record
 *    to the `chant/lifecycle` orphan branch (../../lifecycle/release-ledger.ts).
 *    A deploy composition calls this (typically from a `Verify` phase, or the
 *    CI job that ran `chant build --components --generate <lexicon>`) once
 *    the artifact digest, git sha, and run id are known.
 *  - `chant components status [env]` — the status surface: joins the release
 *    ledger against live evidence (`lifecycle diff --live` + ownership,
 *    reused via `buildChangeSet`) by digest, and reports what's built vs
 *    what's deployed where, flagging unrecorded deploys and drift.
 */
import { resolve } from "node:path";
import { getHeadCommit, fetchLifecycle, pushLifecycle, StaleLifecycleBranchError } from "../../lifecycle/git";
import {
  appendReleaseRecord,
  readReleaseLedger,
  listReleaseEnvironments,
  InvalidReleaseRecordError,
} from "../../lifecycle/release-ledger";
import { reconcileStatus, liveEvidenceFromChangeSet, compareAcrossEnvironments } from "../../lifecycle/status";
import { buildChangeSet } from "../../lifecycle/change-set";
import { loadChantConfig } from "../../config";
import { build } from "../../build";
import { discoverComponents } from "../../components/discover";
import { formatError, formatWarning, formatSuccess, formatBold } from "../format";
import type { CommandContext } from "../registry";
import type { ResourceMetadata } from "../../lexicon";

/**
 * chant components release <env> --component <name> --digest <sha256:...>
 *   [--git-sha <sha>] [--run-id <id>] [--actor <name>]
 *
 * `--git-sha` defaults to the current HEAD commit (`git rev-parse HEAD`);
 * `--run-id` defaults to common CI run-id env vars
 * (`GITHUB_RUN_ID`/`CI_PIPELINE_ID`) or a locally generated id; `--actor`
 * defaults to common CI actor env vars
 * (`GITHUB_ACTOR`/`GITLAB_USER_LOGIN`/`USER`) but must resolve to *something*
 * — an unattributed release record defeats the point of a release ledger, so
 * this is the one field with no silent fallback to a placeholder.
 *
 * The timestamp is always a real `new Date()` taken here, at record time —
 * never threaded in from elsewhere and never mocked in production code, per
 * #568: "the session cannot call Date.now() in some contexts; take the
 * timestamp from the environment/CLI at record time."
 */
export async function runComponentsReleaseRecord(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const environment = args.extraPositional;
  if (!environment) {
    console.error(formatError({
      message: "Environment is required: chant components release <env> --component <name> --digest <sha256:...>",
    }));
    return 1;
  }

  const component = args.component;
  const digest = args.digest;
  if (!component || !digest) {
    console.error(formatError({
      message: "--component and --digest are required",
      hint: "chant components release <env> --component <name> --digest <sha256:...> [--git-sha <sha>] [--run-id <id>] [--actor <name>]",
    }));
    return 1;
  }

  const gitSha = args.gitSha ?? (await getHeadCommit().catch(() => undefined));
  const runId = args.runId ?? process.env.GITHUB_RUN_ID ?? process.env.CI_PIPELINE_ID ?? `local-${Date.now()}`;
  const actor = args.actor ?? process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.USER;

  if (!gitSha) {
    console.error(formatError({ message: "Could not resolve --git-sha (not in a git repo?) — pass it explicitly." }));
    return 1;
  }
  if (!actor) {
    console.error(formatError({
      message: "Could not resolve --actor from the environment",
      hint: "Pass --actor explicitly, or set GITHUB_ACTOR / GITLAB_USER_LOGIN / USER.",
    }));
    return 1;
  }

  const timestamp = new Date().toISOString();

  try {
    const { commit, record } = await appendReleaseRecord({
      component,
      env: environment,
      digest,
      gitSha,
      runId,
      timestamp,
      actor,
    });
    await pushLifecycle();
    if (args.json) {
      console.log(JSON.stringify(record, null, 2));
    } else {
      console.error(formatSuccess(
        `Recorded release: ${formatBold(component)}@${environment} -> ${digest} (commit ${commit.slice(0, 7)})`,
      ));
    }
    return 0;
  } catch (err) {
    if (err instanceof InvalidReleaseRecordError) {
      console.error(formatError({ message: err.message }));
      return 1;
    }
    if (err instanceof StaleLifecycleBranchError) {
      console.error(formatError({
        message: err.message,
        hint: `Pull and retry: \`git fetch origin chant/lifecycle:chant/lifecycle\` && \`chant components release ${environment} --component ${component} --digest ${digest}\`.`,
      }));
      return 1;
    }
    throw err;
  }
}

/** One row of `chant components status` JSON output. */
interface StatusJsonRow {
  component: string;
  env: string;
  recorded: {
    digest: string;
    gitSha: string;
    runId: string;
    timestamp: string;
    actor: string;
  } | null;
  build: {
    manifestDigest: string;
    referrers: string[];
    /** SBOM summary for this digest (#606), when one was generated and is discoverable — archive-carried or referrer-projected. `null` when neither source has one (e.g. the component opted out, or has no built artifact). */
    sbom: { mediaType: string; packageCount?: number; generator?: string; source: string } | null;
    /** This artifact's own honest, per-artifact reproducibility record (#614) — `null` when none is recorded. */
    reproducibility: { basis: string; verifyBy?: string } | null;
  } | null;
  /**
   * Component-level BOM aggregation summary (#614), when the recorded
   * digest's build archive manifest is available. `null` when unavailable
   * (no archive manifest for this digest — the wiring that supplies one is
   * #609's on-disk persistence, not yet in this code path) or when the
   * manifest carries no BOM at all.
   */
  componentBom: {
    leaves: Array<{ path: string; bomKind: string; subjectDigest?: string; mediaType: string; packageCount?: number; generator?: string }>;
    totalPackageCount: number;
    isAssembly: boolean;
  } | null;
  reconciliation: string;
  detail: string;
}

/**
 * chant components status [env] [--live] [--json] [--compare-to <env>]
 *
 * Answers "what's built" and "what's deployed where," joined by digest.
 * Without `--live`, reports the release ledger alone (recorded vs unrecorded
 * is meaningless without live evidence, so every recorded row reports
 * `unknown` reconciliation — still useful as a pure ledger read). With
 * `--live`, joins against `lifecycle diff --live` + ownership (reusing
 * `buildChangeSet`, the same classification `lifecycle plan` already
 * trusts) to flag unrecorded deploys and drift.
 *
 * Omitting `<env>` reports every environment that has release records.
 * `--compare-to <env>` answers the single-query cross-environment question
 * the epic names explicitly: "which build is in `<env>`, and is it the one
 * tested in `<compare-to>`."
 */
export async function runComponentsStatus(ctx: CommandContext): Promise<number> {
  const { args, plugins, serializers } = ctx;
  const requestedEnv = args.extraPositional;

  await fetchLifecycle();

  const environments = requestedEnv ? [requestedEnv] : await listReleaseEnvironments();
  if (environments.length === 0) {
    console.error(formatWarning({
      message: requestedEnv
        ? `No release records found for environment "${requestedEnv}"`
        : "No release records found in any environment",
    }));
    return args.json ? (console.log(JSON.stringify([])), 0) : 0;
  }

  // Discover components (best-effort) so a live/owned-but-never-recorded
  // component still gets a row, not just those that appear in the ledger.
  const { config } = await loadChantConfig(resolve("."));
  const discovery = await discoverComponents(resolve(args.src ?? config.sourceDir ?? "."));
  const allComponents = [...discovery.components.keys()];

  // Component -> live entity/resource name(s) it owns (#598), when declared
  // explicitly via `Component.liveNames`. Components with no `liveNames`
  // simply have no entry here, so `liveEvidenceFromChangeSet` falls back to
  // the name == entity join — no regression for the pilot components.
  const liveNameMapping = new Map<string, string[] | undefined>();
  for (const [name, discovered] of discovery.components) {
    if (discovered.component.liveNames?.length) {
      liveNameMapping.set(name, discovered.component.liveNames);
    }
  }

  const allRows: StatusJsonRow[] = [];
  const ledgerByEnv = new Map<string, Awaited<ReturnType<typeof readReleaseLedger>>>();

  for (const environment of environments) {
    const ledger = await readReleaseLedger(environment);
    ledgerByEnv.set(environment, ledger);
    if (ledger.malformed > 0) {
      console.error(formatWarning({ message: `${environment}: skipped ${ledger.malformed} malformed ledger line(s)` }));
    }

    let liveEvidence;
    if (args.live) {
      const targetSerializers = serializers;
      const buildResult = await build(resolve(args.src ?? config.sourceDir ?? "."), targetSerializers);
      const merged: { env: string; entries: import("../../lifecycle/change-set").ChangeSetEntry[] } = { env: environment, entries: [] };
      for (const plugin of plugins) {
        if (!plugin.describeResources) continue;
        const declared = new Set<string>();
        const entities = new Map<string, { entityType: string; props: Record<string, unknown> }>();
        for (const [name, entity] of buildResult.entities) {
          if (entity.lexicon === plugin.name) {
            declared.add(name);
            entities.set(name, {
              entityType: entity.entityType,
              props: ("props" in entity && entity.props != null ? entity.props : {}) as Record<string, unknown>,
            });
          }
        }
        let observedNow: Record<string, ResourceMetadata>;
        try {
          observedNow = await plugin.describeResources({ environment, buildOutput: "", entityNames: Array.from(declared), entities });
        } catch (err) {
          console.error(formatWarning({ message: `${plugin.name}: describeResources failed — ${err instanceof Error ? err.message : String(err)}` }));
          continue;
        }
        const cs = buildChangeSet(environment, { declared, observedNow, observedThen: undefined });
        merged.entries.push(...cs.entries);
      }
      liveEvidence = liveEvidenceFromChangeSet(merged, liveNameMapping);
    }

    const rows = reconcileStatus(environment, ledger.records, {
      liveEvidence,
      allComponents,
    });

    for (const row of rows) {
      allRows.push({
        component: row.component,
        env: row.env,
        recorded: row.recorded
          ? {
              digest: row.recorded.digest,
              gitSha: row.recorded.gitSha,
              runId: row.recorded.runId,
              timestamp: row.recorded.timestamp,
              actor: row.recorded.actor,
            }
          : null,
        build: row.build
          ? {
              manifestDigest: row.build.manifestDigest,
              referrers: row.build.referrers.map((r) => r.kind),
              sbom: row.build.sbom
                ? {
                    mediaType: row.build.sbom.mediaType,
                    packageCount: row.build.sbom.packageCount,
                    generator: row.build.sbom.generator,
                    source: row.build.sbom.source,
                  }
                : null,
              reproducibility: row.build.reproducibility
                ? { basis: row.build.reproducibility.basis, verifyBy: row.build.reproducibility.verifyBy }
                : null,
            }
          : null,
        componentBom: row.componentBom
          ? {
              leaves: row.componentBom.leaves.map((l) => ({
                path: l.path,
                bomKind: l.bomKind,
                subjectDigest: l.subjectDigest,
                mediaType: l.mediaType,
                packageCount: l.packageCount,
                generator: l.generator,
              })),
              totalPackageCount: row.componentBom.totalPackageCount,
              isAssembly: row.componentBom.isAssembly,
            }
          : null,
        reconciliation: row.reconciliation,
        detail: row.detail,
      });
    }
  }

  // `--compare-to` — single-query cross-env digest comparison, per component.
  let comparisons: ReturnType<typeof compareAcrossEnvironments>[] | undefined;
  if (args.compareTo && requestedEnv) {
    const otherLedger = ledgerByEnv.get(args.compareTo) ?? (await readReleaseLedger(args.compareTo));
    const componentsToCompare = new Set([...allRows.map((r) => r.component)]);
    comparisons = [...componentsToCompare].sort().map((component) =>
      compareAcrossEnvironments(
        component,
        { name: requestedEnv, records: ledgerByEnv.get(requestedEnv)?.records ?? [] },
        { name: args.compareTo!, records: otherLedger.records },
      ),
    );
  }

  if (args.json) {
    console.log(JSON.stringify(comparisons ? { rows: allRows, comparisons } : allRows, null, 2));
    return 0;
  }

  console.log(
    formatBold("COMPONENT".padEnd(24)) +
    formatBold("ENV".padEnd(12)) +
    formatBold("DIGEST".padEnd(20)) +
    formatBold("STATUS".padEnd(14)) +
    formatBold("DETAIL"),
  );
  console.log("-".repeat(110));
  for (const row of allRows) {
    const digestShort = row.recorded ? row.recorded.digest.slice(0, 19) : "-";
    console.log(
      row.component.padEnd(24) +
      row.env.padEnd(12) +
      digestShort.padEnd(20) +
      row.reconciliation.padEnd(14) +
      row.detail,
    );
  }

  if (comparisons) {
    console.log(`\n${formatBold(`Cross-check: ${requestedEnv} vs ${args.compareTo}`)}`);
    for (const c of comparisons) {
      const verdict = c.same ? "same build" : "DIFFERENT builds";
      console.log(`  ${c.component}: ${c.digestA ?? "(none)"} vs ${c.digestB ?? "(none)"} — ${verdict}`);
    }
  }

  const unrecordedCount = allRows.filter((r) => r.reconciliation === "unrecorded").length;
  const driftedCount = allRows.filter((r) => r.reconciliation === "drifted").length;
  if (unrecordedCount === 0 && driftedCount === 0) {
    console.error(formatSuccess(`No unrecorded deploys or drift across ${allRows.length} row(s)`));
  } else {
    console.error(formatWarning({ message: `${unrecordedCount} unrecorded, ${driftedCount} drifted` }));
  }

  return 0;
}

/** Fallback for `chant components` with no/unknown subcommand. */
export async function runComponentsUnknown(ctx: CommandContext): Promise<number> {
  console.error(formatError({
    message: `Unknown components subcommand: ${ctx.args.path}`,
    hint: "Available: chant components status [env], chant components release <env>",
  }));
  return 1;
}
