/**
 * LexiconUpgradeOp composite — the runner that dogfoods chant to keep each
 * in-scope lexicon current with its upstream spec (#527, epic #523).
 *
 * The shared tooling (#524) does the regen + surface-diff; the pinned (#525)
 * and rolling (#526) pipelines do the detection. This Op wires them into an
 * audit-style operational layer, modeled on `WorkflowAuditOp` / `PipelineAuditOp`:
 * phases detect → run the right check for the lexicon → surface-diff → finding.
 *
 * It runs one-shot on the **local Op executor** via `chant run` — nothing
 * durable is required for an upgrade check (the scheduled CI runner is the
 * trigger). A `schedule` may still be supplied for continuous re-check; it
 * lands on the Op itself (#2120).
 *
 * Lexicon classification (which check the activity dispatches to):
 *   PINNED  {k8s, gcp, docker, gitlab} → checkPinnedUpgrade
 *   ROLLING {aws, azure, github}       → checkRollingUpgrade
 * helm / forgejo are excluded — no upstream spec.
 *
 * Finding-modes mirror ReconcileOp: `report` (default, no external services)
 * | `issue` | `pull-request`. For the epic goal, `pull-request` opens/updates a
 * long-lived branch per lexicon.
 *
 * @example
 * ```typescript
 * // one-shot, local executor, report only
 * export const { op } = LexiconUpgradeOp({ lexicon: "aws" });
 *
 * // weekly, opening a PR when an upgrade is ready
 * export const { op } = LexiconUpgradeOp({
 *   lexicon: "k8s",
 *   schedule: "0 6 * * 1",
 *   onFinding: "pull-request",
 * });
 * ```
 *
 * @see #524 — shared regen-validate + surface-diff tooling.
 * @see #525 — pinned-version bump pipeline.
 * @see #526 — rolling-spec drift pipeline.
 */

import { Op, phase } from "../builders";
import type { OpResource } from "../resource";
import type { LexiconUpgradeMode, SupportedLexicon } from "../activities/lexicon-upgrade";

/** The in-scope lexicons. helm / forgejo are excluded (no upstream spec). */
export const IN_SCOPE_LEXICONS: readonly SupportedLexicon[] = [
  "k8s",
  "gcp",
  "docker",
  "gitlab",
  "aws",
  "azure",
  "github",
  "fly",
  "cedar",
] as const;

export interface LexiconUpgradeOpConfig {
  /** Which in-scope lexicon to check. */
  lexicon: SupportedLexicon;
  /**
   * Op name (kebab-case). Names the Op's output directory and is what `chant
   * run` takes. Defaults to `<lexicon>-upgrade`.
   */
  name?: string;
  /**
   * Cron expression. When set, it lands on the Op as `schedule` for
   * continuous re-check; omit for one-shot `chant run` on the local executor.
   */
  schedule?: string;
  /**
   * Absolute path to the lexicon root, forwarded to the activity. Defaults to
   * `<cwd>/lexicons/<lexicon>` at run time.
   */
  lexiconDir?: string;
  /**
   * What to produce on findings. Default: "report".
   * @default "report"
   */
  onFinding?: LexiconUpgradeMode;
}

export interface LexiconUpgradeOpResources {
  /** Op resource — the upgrade Op, emitted on `chant build`. */
  op: InstanceType<typeof OpResource>;
}

/**
 * Build a LexiconUpgradeOp for one lexicon. Rejects out-of-scope lexicons at
 * construction time so a typo never silently produces a no-op Op.
 */
export function LexiconUpgradeOp(config: LexiconUpgradeOpConfig): LexiconUpgradeOpResources {
  if (!IN_SCOPE_LEXICONS.includes(config.lexicon)) {
    throw new Error(
      `LexiconUpgradeOp: "${config.lexicon}" is not in scope. ` +
        `In-scope lexicons: ${IN_SCOPE_LEXICONS.join(", ")} ` +
        `(helm, forgejo have no upstream spec).`,
    );
  }

  const name = config.name ?? `${config.lexicon}-upgrade`;
  const onFinding = config.onFinding ?? "report";

  const op = Op({
    name,
    overview:
      "Detect a newer upstream spec for the lexicon, regen + validate, and surface the API-surface delta",
    labels: {
      Upgrade: "true",
      Lexicon: config.lexicon,
    },
    ...(config.schedule ? { schedule: { cron: config.schedule, overlap: "skip" as const } } : {}),
    phases: [
      phase("Upgrade", [
        {
          kind: "activity",
          fn: "lexiconUpgrade",
          args: {
            lexicon: config.lexicon,
            ...(config.lexiconDir ? { lexiconDir: config.lexiconDir } : {}),
            mode: onFinding,
          },
          // Surface whether a PR-worthy upgrade was found as the run's
          // `HasUpgrade` outcome on the run ledger, so a reader can pick out
          // the lexicons with an upgrade ready.
          outcomeAttribute: { name: "HasUpgrade", from: "hasUpgrade" },
        },
      ]),
    ],
  });

  return { op };
}
