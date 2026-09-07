/**
 * WatchOp composite — periodic state observation as an Op.
 *
 * Composes existing pieces:
 *   - The local executor (`../local-executor.ts`) runs the phases in order and
 *     files each step's record under the phase it belongs to
 *   - The pre-built lifecycleSnapshot + lifecycleDiff activities
 *   - `schedule` puts the cadence on the Op itself (#2120)
 *
 * The cron is Op data, not a resource: `chant operator` ticks on it, the
 * github/gitlab/forgejo generators render it as a CI cron, and a hosting
 * lexicon hands it to its own scheduler.
 *
 * @example
 * ```typescript
 * export const { op } = WatchOp({
 *   name: "prod-watch",
 *   env: "prod",
 *   schedule: "0,15,30,45 * * * *", // every 15 minutes
 * });
 * ```
 *
 * @see #31 — Continuous observation (the issue this composite addresses)
 */

import { Op, phase, activity } from "../builders";
import { receiptCheckInput } from "../receipt-store";
import type { OpResource } from "../resource";
import type { EffectReceiptDeclaration } from "../../effect-receipt";

export interface WatchOpConfig {
  /** Op name (kebab-case). Names the Op's output directory and is what `chant run` takes. */
  name: string;
  /** Environment to snapshot + diff (e.g. "prod"). */
  env: string;
  /**
   * Cron expression controlling how often the watch runs. Omit for a
   * one-shot `chant run` on the local executor.
   * @example "0,15,30,45 * * * *" — every 15 minutes
   * @example "0 * * * *" — hourly
   */
  schedule?: string;
  /**
   * Run `chant lifecycle diff --live` (queries cloud APIs) instead of the
   * default digest-only diff. Recommended for real drift detection.
   * @default true
   */
  live?: boolean;
  /**
   * Effect receipts to check for staleness between change windows (#1834,
   * epic #1703). Typed references only — import each EffectReceipt const.
   * Read-only: the watch reads each receipt through the receipt store
   * (provided by the receipt row's lexicon, #1835) and reports absent or
   * differing values as findings. It never runs an effect and never writes
   * a receipt — the `effect()` step is the sole writer.
   */
  receipts?: EffectReceiptDeclaration[];
}

export interface WatchOpResources {
  /** Op resource — the snapshot+diff Op, emitted on `chant build`. */
  op: InstanceType<typeof OpResource>;
}

export function WatchOp(config: WatchOpConfig): WatchOpResources {
  const live = config.live ?? true;

  const op = Op({
    name: config.name,
    overview: `Periodically snapshot and diff the ${config.env} environment`,
    labels: {
      Watch: "true",
      Env: config.env,
    },
    ...(config.schedule ? { schedule: { cron: config.schedule, overlap: "skip" as const } } : {}),
    phases: [
      phase("Snapshot", [activity("lifecycleSnapshot", { env: config.env })]),
      phase("Diff", [
        // outcomeAttribute surfaces lifecycleDiff's `drifted` boolean as the
        // run's `Drift` outcome on the run ledger, so a reader of the ledger
        // can pick out the runs that detected drift.
        {
          kind: "activity",
          fn: "lifecycleDiff",
          args: { env: config.env, live },
          outcomeAttribute: { name: "Drift", from: "drifted" },
        },
      ]),
      // Receipt staleness (#1834): read-only over the receipt store — absent
      // or differing receipts surface as findings (and a StaleReceipts run
      // outcome); nothing runs and nothing is written.
      ...(config.receipts && config.receipts.length > 0
        ? [
            phase("Receipts", [
              {
                kind: "activity" as const,
                fn: "receiptStaleness",
                args: { receipts: config.receipts.map(receiptCheckInput) },
                outcomeAttribute: { name: "StaleReceipts", from: "stale" },
              },
            ]),
          ]
        : []),
    ],
  });

  return { op };
}
