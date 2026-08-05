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
 *
 * `componentBom`/`build.reproducibility` (#614) resolve to real data as of
 * #609: for every recorded digest in an environment's ledger, this handler
 * looks up the persisted `BuildArchiveManifest` that produced it
 * (`findBuildManifestByArtifactDigest`, ../../lifecycle/build-ledger-
 * store.ts) and derives `buildsByDigest`/`componentBomByDigest` from it via
 * `buildLedgerEntries`/`componentBomSummary` — the same derivation
 * `build-ledger.test.ts` already exercises directly, now fed by a real
 * manifest instead of a hand-built one. A digest with no persisted manifest
 * (predates #609, or was recorded via `chant components release` alone with
 * no corresponding build) simply has no entry in either map, so `build`/
 * `componentBom` fall back to `null` exactly as before — no regression for
 * ledgers with no persisted manifests at all.
 */
import { resolve } from "node:path";
import { getHeadCommit, fetchLifecycle, pushLifecycle, StaleLifecycleBranchError } from "../../lifecycle/git";
import {
  appendReleaseRecord,
  readReleaseLedger,
  listReleaseEnvironments,
  InvalidReleaseRecordError,
} from "../../lifecycle/release-ledger";
import { reconcileStatus, liveEvidenceFromChangeSet, compareAcrossEnvironments, mergeLiveEvidence, type LiveComponentEvidence } from "../../lifecycle/status";
import { commandBuildParams } from "../build-params-cli";
import { buildChangeSet } from "../../lifecycle/change-set";
import { buildLedgerEntries, componentBomSummary, type BuildLedgerEntry } from "../../lifecycle/build-ledger";
import { findBuildManifestByArtifactDigest } from "../../lifecycle/build-ledger-store";
import type { ComponentBomSummary } from "../../lifecycle/build-ledger";
import { loadChantConfig } from "../../config";
import { applyLiveEndpoint } from "../../live-endpoint";
import { build } from "../../build";
import { discoverComponents } from "../../components/discover";
import { formatError, formatWarning, formatSuccess, formatBold } from "../format";
import type { CommandContext } from "../registry";
import type { LexiconPlugin } from "../../lexicon";
import { normalizeObservation, mergeObservations, unobservedAll, type NormalizedObservation } from "../../observation";
import type { Phase, Component } from "../../components/component";

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
      hint: "chant components release <env> --component <name> --digest <sha256:...> [--git-sha <sha>] [--run-id <id>] [--actor <name>] [--approver <name>]",
    }));
    return 1;
  }

  const gitSha = args.gitSha ?? (await getHeadCommit().catch(() => undefined));
  const runId = args.runId ?? process.env.GITHUB_RUN_ID ?? process.env.CI_PIPELINE_ID ?? `local-${Date.now()}`;
  const actor = args.actor ?? process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.USER;
  // Who approved a gated change (#1035). Optional — omitted for an ungated
  // change, and never defaulted to `actor`, since recording the approver as the
  // triggerer would defeat the separation-of-duties the field exists to attest.
  const approver = args.approver;

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
      ...(approver ? { approver } : {}),
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
   * digest's build archive manifest is available — resolved from the
   * persisted manifest store (#609, ../../lifecycle/build-ledger-store.ts)
   * by digest. `null` when unavailable (no manifest was ever persisted for
   * this digest — it predates #609, or was recorded via `chant components
   * release` alone with no corresponding `chant build`/`run`) or when the
   * manifest carries no BOM at all.
   */
  componentBom: {
    leaves: Array<{ path: string; bomKind: string; subjectDigest?: string; mediaType: string; packageCount?: number; generator?: string }>;
    totalPackageCount: number;
    isAssembly: boolean;
  } | null;
  reconciliation: string;
  detail: string;
  /** Present only when live state was requested AND read (#1089) — see `unobserved`. */
  live?: boolean;
  /** Why live state could not be read for this component (#1089). Mutually exclusive with `live`. */
  unobserved?: { reason: string; detail?: string };
  stack?: { name: string; status?: string; healthy?: boolean };
  /**
   * How this component's own resources answered (behold#98, chant#1300).
   *
   * `stack` above exists only where the substrate has a deploy object to read,
   * which is AWS; these counts are the substrate-neutral answer to the same
   * question, and finer-grained than a single stack verdict wherever both are
   * present. #1300 added the field to `ComponentStatusRow` but not to this
   * projection, which is the only surface a consumer sees — so until behold#100
   * it never left the CLI.
   *
   * On AWS the counts inherit `describe-stack-resources`, so they report
   * CloudFormation's per-resource inventory rather than independently observed
   * existence; the per-type reader registry (#1269/#1271) applied to this thin
   * path is what would make them a live check.
   */
  resources?: { total: number; present: number; absent: number; unobserved: number };
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
/** Every distinct `cfn-deploy` stack name a component's deploy phases target. A
 * step may itself be a nested `Phase`, so walk recursively; a resolved component
 * carries the stack as a concrete string.
 *
 * Exported for `chant graph --live` (../handlers/graph.ts's `runGraphLive`,
 * #57): the same per-component stack resolution this file uses for `chant
 * components status --live` is also how the live graph learns which stacks to
 * observe on a multi-stack, per-component project (`describeResources`'s
 * single-stack-named-after-the-environment convention never matches one). */
export function cfnDeployStacks(deploy: Phase[]): string[] {
  const stacks = new Set<string>();
  const walkSteps = (steps: Phase["steps"]): void => {
    for (const step of steps) {
      // A step may itself be a nested Phase (it carries its own `steps`). Step is
      // open-typed (capability inputs), so discriminate structurally on `steps`.
      const nested = (step as { steps?: unknown }).steps;
      if (Array.isArray(nested)) {
        walkSteps(nested as Phase["steps"]);
        continue;
      }
      const s = step as { kind?: string; stack?: unknown };
      if (s.kind === "cfn-deploy" && typeof s.stack === "string") stacks.add(s.stack);
    }
  };
  for (const phase of deploy) walkSteps(phase.steps);
  return [...stacks];
}

/**
 * Per-component stack presence for `--live`: resolve each component's own
 * `cfn-deploy` stack(s) and observe them directly via a lexicon's
 * `describeStackStatus`. This is the multi-stack component signal that
 * `describeResources` (entity-keyed, single-stack-per-env) misses (#57): a
 * component whose stack is present reconciles as live/owned, joined to the DAG
 * by component name. Components with no `cfn-deploy` stack — or where the
 * observer can't determine any of theirs — are omitted, so the change-set
 * evidence still governs them.
 */
async function observeComponentStacks(
  components: Map<string, { component: Component }>,
  observer: LexiconPlugin,
  environment: string,
): Promise<Map<string, LiveComponentEvidence>> {
  const evidence = new Map<string, LiveComponentEvidence>();
  for (const [name, { component }] of components) {
    const stacks = cfnDeployStacks(component.deploy);
    if (stacks.length === 0) continue;
    const observed = await Promise.all(
      stacks.map((stack) => observer.describeStackStatus!({ environment, stack }).catch(() => null)),
    );
    const determinate = observed.filter((o): o is NonNullable<typeof o> => o !== null);
    if (determinate.length === 0) {
      // Every stack read came back indeterminate (the lexicon's own "I cannot
      // tell" — see describeStackStatus). Record the hole rather than dropping
      // the component, which would leave a recorded component reading `stale`
      // (#1089).
      evidence.set(name, {
        live: false,
        unobserved: {
          reason: "read-failed",
          detail: `no determinate status for stack(s): ${stacks.join(", ")}`,
        },
      });
      continue;
    }
    const present = determinate.every((o) => o.present);
    // Surface the (first present, else first) stack's raw status for a richer
    // palette than the reconciliation verdict. One cfn-deploy stack per component
    // is the norm; a multi-stack component reports its representative unit.
    const repr = determinate.find((o) => o.present) ?? determinate[0];
    evidence.set(name, {
      live: present,
      ownership: present ? "owned" : undefined,
      stack: { name: repr.stack, status: repr.status, healthy: repr.healthy },
    });
  }
  return evidence;
}

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
  const discovery = await discoverComponents(resolve(args.src ?? config.sourceDir ?? "."), {
    sandbox: args.sandbox,
  });
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
      // #1166 — an environment can declare its own endpoint (a local emulator
      // like Floci), applied here unless the ambient shell already set it, so
      // `--live` status doesn't silently read the wrong account per environment.
      const endpointResult = applyLiveEndpoint(
        config.environments,
        environment,
        plugins.filter((p) => p.describeResources || p.describeStackStatus),
      );
      if (endpointResult.notice) console.error(formatWarning({ message: endpointResult.notice }));
      try {
        const targetSerializers = serializers;
        // With this invocation's parameters (#1483). Built on defaults, the
        // declared half of the comparison is a different estate from the one
        // deployed, and every resource the real parameter declares reads as
        // absent.
        const statusParams = await commandBuildParams(config.buildParams, args);
        if (!statusParams) return 1;
        const buildResult = await build(resolve(args.src ?? config.sourceDir ?? "."), targetSerializers, undefined, {
          buildParams: statusParams,
        });
        // Which deployed stack(s) to read the change set from (behold#100).
        //
        // `describeResources` defaults to the single-stack convention — the
        // stack named after the environment — which is wrong for exactly the
        // projects this command exists for: a component project deploys the
        // stack its own `cfn-deploy` names, and that is almost never the env
        // name. Every declared resource then came back absent, so the rollup
        // #1300 computes read `present: 0` over a healthy estate. That was
        // invisible while nothing consumed the rollup; behold#100 paints from
        // it, so it has to be right.
        //
        // The components' own `cfn-deploy` stacks are the authority (the same
        // ones `observeComponentStacks` reads below), with `config.stacks` as
        // the declared override for a project whose stacks aren't derivable
        // from a deploy step. `[undefined]` keeps the old single-read
        // behaviour for a project with neither.
        const componentStackNames = new Set<string>();
        for (const { component } of discovery.components.values()) {
          for (const stack of cfnDeployStacks(component.deploy)) componentStackNames.add(stack);
        }
        for (const stack of config.stacks ?? []) componentStackNames.add(stack.name);
        const readTargets: Array<string | undefined> = componentStackNames.size ? [...componentStackNames] : [undefined];
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
          let observed: NormalizedObservation;
          try {
            observed = mergeObservations(
              await Promise.all(
                readTargets.map(async (stack) =>
                  normalizeObservation(
                    await plugin.describeResources!({
                      environment,
                      buildOutput: "",
                      entityNames: Array.from(declared),
                      entities,
                      ...(stack ? { stack } : {}),
                    }),
                  ),
                ),
              ),
            );
          } catch (err) {
            // A failed read is not an empty environment (#1089): mark every
            // declared entity NOT-OBSERVED so the status rows say "unknown"
            // rather than "stale" (recorded, and nothing live).
            const message = err instanceof Error ? err.message : String(err);
            console.error(formatWarning({ message: `${plugin.name}: describeResources failed — ${message} (components in this lexicon report unknown, not stale)` }));
            observed = { resources: {}, unobserved: unobservedAll(declared, "read-failed", message, entities) };
          }
          const cs = buildChangeSet(environment, {
            declared,
            observedNow: observed.resources,
            observedThen: undefined,
            unobserved: observed.unobserved,
          });
          merged.entries.push(...cs.entries);
        }
        liveEvidence = liveEvidenceFromChangeSet(merged, liveNameMapping);

        // Multi-stack component projects (each component owns its own stack) are
        // invisible to the entity-keyed, single-stack `describeResources` above —
        // observe each component's own cfn-deploy stack directly and overlay it as
        // the authoritative presence signal (#57).
        const stackObserver = plugins.find((p) => p.describeStackStatus);
        if (stackObserver) {
          const stackEvidence = await observeComponentStacks(discovery.components, stackObserver, environment);
          liveEvidence = mergeLiveEvidence(liveEvidence, stackEvidence);
        }
      } finally {
        endpointResult.restore();
      }
    }

    // #609: resolve the persisted build manifest behind each recorded digest
    // (if any) so `build`/`componentBom` are real queries, not always null.
    const buildsByDigest = new Map<string, BuildLedgerEntry>();
    const componentBomByDigest = new Map<string, ComponentBomSummary>();
    const recordedDigests = new Set(ledger.records.map((r) => r.digest));
    for (const digest of recordedDigests) {
      const manifest = await findBuildManifestByArtifactDigest(digest);
      if (!manifest) continue;

      const bom = componentBomSummary(manifest);
      if (bom) componentBomByDigest.set(digest, bom);

      const ledgerEntries = await buildLedgerEntries(manifest);
      const entry = ledgerEntries.find((e) => e.digest === digest);
      if (entry) buildsByDigest.set(digest, entry);
    }

    const rows = reconcileStatus(environment, ledger.records, {
      liveEvidence,
      allComponents,
      buildsByDigest,
      componentBomByDigest,
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
        ...(row.live !== undefined ? { live: row.live } : {}),
        ...(row.unobserved ? { unobserved: row.unobserved } : {}),
        ...(row.stack ? { stack: row.stack } : {}),
        ...(row.resources ? { resources: row.resources } : {}),
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
