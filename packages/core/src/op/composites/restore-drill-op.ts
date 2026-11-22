/**
 * RestoreDrillOp composite: a restore drill as a committed Op (#5450).
 *
 * The Op restores the newest backup of one declared store into a scratch
 * environment, runs the checks it declares, tears the scratch environment
 * down, and records the restore's elapsed time (RTO achieved) and the backup's
 * age at restore (RPO achieved) on `chant/lifecycle`, at
 * `<env>/drills.jsonl`. With `targets` declared, a drill that misses one
 * fails and says by how much. `chant workspace status` shows the newest drill
 * of each store. A `schedule` puts the cadence on the Op, which the CI
 * workflow generator renders as a scheduled job.
 *
 * It is one Op per store: the store's `name` is the key its drills are
 * recorded and shown under.
 *
 * @example
 * ```typescript
 * export const { op } = RestoreDrillOp({
 *   name: "orders-restore-drill",
 *   env: "prod",
 *   store: { kind: "rds", name: "orders", instance: "orders-prod" },
 *   checks: [{ name: "rows", kind: "command", cmd: 'psql "host=${DRILL_ENDPOINT}" -tAc "select count(*) from orders"', expect: { atLeast: 1 } }],
 *   targets: { rto: "4h", rpo: "15m" },
 *   schedule: "0 3 * * 0",
 * });
 * ```
 */

import { Op, activity, phase } from "../builders";
import type { OpResource } from "../resource";
import type { DrillCheck, DrillStoreSpec } from "../activities/restore-drill";
import { drillProblems } from "../activities/restore-drill";
import { parseDrillTargets, type DrillTargetsInput } from "../../lifecycle/drill-record";

export interface RestoreDrillOpConfig {
  /** Op name (kebab-case); what `chant run` takes. */
  name: string;
  /** The store to drill. Its `name` is the key drills are recorded and shown under. */
  store: DrillStoreSpec;
  /** The environment the store lives in. Drills are recorded under it, and the Op's `labels.Env` is set to it. */
  env: string;
  /** Checks run against the restored store, in order. All of them run; each result is recorded. */
  checks?: DrillCheck[];
  /** `rto` and `rpo` as durations (`"4h"`, `"15m"`). A target left out is not checked. */
  targets?: DrillTargetsInput;
  /** The scratch environment's name, which must start with `drill-`. Default: `drill-<store>-<minute>`. */
  scratch?: string;
  /** Cron expression. When set, it lands on the Op as `schedule`; omit for a drill run by hand. */
  schedule?: string;
}

export interface RestoreDrillOpResources {
  /** Op resource, emitted on `chant build`. */
  op: InstanceType<typeof OpResource>;
}

export function RestoreDrillOp(config: RestoreDrillOpConfig): RestoreDrillOpResources {
  // A drill that cannot run should fail the build, not the night it was scheduled.
  const problems = drillProblems({ store: config.store, ...(config.checks ? { checks: config.checks } : {}), ...(config.scratch ? { scratch: config.scratch } : {}) }, config.scratch ?? "drill-validate");
  if (problems.length > 0) throw new Error(`RestoreDrillOp ${config.name}: ${problems.join("; ")}`);
  parseDrillTargets(config.targets);

  const op = Op({
    name: config.name,
    overview: `Restore the newest backup of ${config.store.name} into a scratch environment, check it, tear it down, and record RTO and RPO`,
    labels: { Drill: "restore", Store: config.store.name, Env: config.env },
    ...(config.schedule ? { schedule: { cron: config.schedule, overlap: "skip" as const } } : {}),
    phases: [
      phase("Drill", [
        {
          kind: "activity",
          fn: "restoreDrill",
          args: {
            store: config.store,
            env: config.env,
            op: config.name,
            ...(config.scratch ? { scratch: config.scratch } : {}),
            ...(config.checks ? { checks: config.checks } : {}),
            ...(config.targets ? { targets: config.targets } : {}),
          },
          // One attempt: a second attempt would restore a second copy, and a drill's timing is a single try.
          profile: "atMostOnce",
          timeout: "6h",
          // What the run ledger keeps beside the drill's own record on chant/lifecycle.
          outcomeAttribute: [
            { name: "Outcome", from: "outcome" },
            { name: "RtoMs", from: "rtoMs" },
            { name: "RpoMs", from: "rpoMs" },
            { name: "Met", from: "met" },
            { name: "DrillId", from: "id" },
          ],
        },
      ]),
    ],
  });
  return { op };
}
