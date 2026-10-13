/**
 * `ClickHouseRebuildOp` (#3198): the change ClickHouse cannot make with
 * `ALTER` (a sorting key, a primary key, a partition key, an engine, a key
 * column's type), run as a gated composite Op.
 *
 *     export const { op } = ClickHouseRebuildOp({
 *       name: "rebuild-shop-events",
 *       env: "prod",
 *       table: "shop.events",
 *       dualWrite: { mode: "materialized-view", cutoverColumn: "ts" },
 *     });
 *
 * | Phase | Step |
 * |---|---|
 * | Build | `chant build` (`build: false` skips it) |
 * | Plan | classify the table's change against the server; refuse what is not a rebuild |
 * | Create | the new table, `t__chant_new`, from the declaration |
 * | Dual write | a materialized view from the old table to the new one, or a gate for the app to stop writing |
 * | Backfill | `INSERT ... SELECT` per partition, each with a receipt |
 * | Verify | row counts and checksums per partition |
 * | Approve | a gate bound to the plan and the verification |
 * | Swap | `EXCHANGE TABLES`, then recreate the materialized views that read the table |
 * | Retain | the old table, `t__chant_old`, until `retain` has passed |
 * | Approve drop | a gate bound to that old table |
 * | Drop | the old table, once its date has passed |
 * | onFailure | drop the new table and the dual-write view |
 *
 * `gates: "outer"` (#3658) leaves out both approval gates and the Drop phase,
 * for a caller that runs the Op under an approval of its own: the run goes
 * from Plan to Retain, verification and the swap's own comparison included.
 * `onFailure: "keep"` leaves out the onFailure, so a failed run's next run
 * resumes the backfill from its receipts instead of starting again.
 *
 * Run it until it is done: each run goes as far as the next gate. Every step
 * re-reads the server, so a run after a gate, a crash or an approval picks up
 * where the last stopped. A run killed during the backfill (Ctrl-C, a lost
 * machine) is not a failure, runs no onFailure, and the next run resumes the
 * backfill from its receipts; a step that fails runs onFailure, and the next
 * run starts again from a new table.
 */

import { Op, activity, gate, phase, stepOutput, type GateApproval } from "@intentius/chant/op";
import type { OpResource } from "@intentius/chant/op";
import type { StepDefinition } from "@intentius/chant/op";
import type { DualWrite } from "./observe";

export interface ClickHouseRebuildOpConfig {
  /** Op name (kebab-case). */
  name: string;
  /** The chant environment: selects `sql.profiles.<env>`. */
  env: string;
  /** The table to rebuild, `database.name` as the server knows it (or its export name). */
  table: string;
  /** How writes reach the new table while it is filled. */
  dualWrite: DualWrite;
  /** The build output the declaration is read from. Default: `dist/schema.json`. */
  output?: string;
  /** Project directory to build. Default: `.`. */
  path?: string;
  /** Run `chant build` first (the project's `build` script). Default: true. */
  build?: boolean;
  /** How long the old table is kept after the swap, as a duration (`7d`, `36h`). Default: `7d`. */
  retain?: string;
  /**
   * Whose approval the swap and the drop wait for. `"own"` (the default): the
   * Op's two gates. `"outer"`: an approval the caller already holds for a
   * larger change that runs this Op as one of its steps. The swap gate, the
   * drop gate and the Drop phase are left out, so the Op ends at Retain with
   * the old table kept as `<table>__chant_old` with its retention date. Drop
   * it after that date, or run the Op with `"own"`: its swap gate has
   * nothing left to swap, and its drop gate binds that old table.
   * The verification still runs, and the swap compares the tables again
   * before the `EXCHANGE`: any difference fails the run with nothing swapped.
   * App mode's writes-stopped gate is not an approval and stays.
   */
  gates?: "own" | "outer";
  /**
   * What a failed run does with the new table and the dual-write view.
   * `"drop"` (the default): onFailure drops them, and the next run starts
   * again from a new table. `"keep"`: there is no onFailure, and the next run
   * resumes the backfill from its per-partition receipts. To start again
   * instead, drop `<table>__chant_new` and `<table>__chant_dual`.
   */
  onFailure?: "drop" | "keep";
  /** The gate before the swap. Default name `approve-<name>`. */
  gate?: {
    gate?: string;
    timeout?: string;
    description?: string;
    /** Quorum, roles and a policy (#2508). With a policy, the verification's counts are added to its context. */
    approval?: GateApproval;
  };
  /** The gate before the old table is dropped. Default name `approve-<name>-drop`. */
  dropGate?: { gate?: string; timeout?: string; description?: string };
  /** App mode: the gate the application's write stop is confirmed at. Default name `<name>-writes-stopped`. */
  writesGate?: { gate?: string; timeout?: string; description?: string };
  /** One attempt of the backfill step. Default: `6h`, the longest a step may run. */
  backfillTimeout?: string;
  /** How long to wait for one table's mutations. Default: `10m`. */
  mutationTimeout?: string;
  /**
   * In a Replicated database, how long a step that reads rows waits for the
   * replica it talks to to fetch what the others wrote, before it stops
   * naming a replica that is down and holds parts no other has. Each attempt
   * of the step waits this long. Default: `2m`.
   */
  replicaTimeout?: string;
  /**
   * Materialized-view mode: how long the backfill waits, once the cut-over
   * has passed, for INSERTs into the old table begun before it to finish and
   * for asynchronous inserts queued before it to be flushed, before it stops
   * naming them. Default: `10m`.
   */
  cutoverTimeout?: string;
  /** Ownership stack. Default: `ownership.stack` in `chant.config.ts`. */
  stack?: string;
  /** Ownership env. Default: `ownership.env` in `chant.config.ts`. */
  ownershipEnv?: string;
}

export interface ClickHouseRebuildOpResources {
  op: InstanceType<typeof OpResource>;
}

/** The arguments every rebuild activity takes. */
export interface ClickHouseRebuildArgs {
  table: string;
  buildPath: string;
  environment?: string;
  dualWrite: DualWrite;
  retain?: string;
  mutationTimeout?: string;
  replicaTimeout?: string;
  cutoverTimeout?: string;
  stack?: string;
  ownershipEnv?: string;
  cwd?: string;
  /** A failed run keeps the new table (`onFailure: "keep"`): a refusal says to drop it by hand. */
  keepOnFailure?: boolean;
}

export function ClickHouseRebuildOp(config: ClickHouseRebuildOpConfig): ClickHouseRebuildOpResources {
  if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$|^[A-Za-z_][A-Za-z0-9_]*$/.test(config.table)) {
    throw new Error(`ClickHouseRebuildOp "${config.name}": table must be "database.name" or an export name, got ${JSON.stringify(config.table)}`);
  }
  if (config.dualWrite?.mode !== "materialized-view" && config.dualWrite?.mode !== "app") {
    throw new Error(`ClickHouseRebuildOp "${config.name}": dualWrite.mode must be "materialized-view" or "app"`);
  }
  if (config.dualWrite.mode === "materialized-view" && !config.dualWrite.cutoverColumn) {
    throw new Error(`ClickHouseRebuildOp "${config.name}": materialized-view mode needs cutoverColumn, the time column rows are cut over on`);
  }
  if (config.gates !== undefined && config.gates !== "own" && config.gates !== "outer") {
    throw new Error(`ClickHouseRebuildOp "${config.name}": gates must be "own" or "outer"`);
  }
  if (config.onFailure !== undefined && config.onFailure !== "drop" && config.onFailure !== "keep") {
    throw new Error(`ClickHouseRebuildOp "${config.name}": onFailure must be "drop" or "keep"`);
  }
  const outer = config.gates === "outer";
  const keep = config.onFailure === "keep";

  const args: ClickHouseRebuildArgs = {
    table: config.table,
    buildPath: config.output ?? "dist/schema.json",
    environment: config.env,
    dualWrite: config.dualWrite,
    ...(config.retain ? { retain: config.retain } : {}),
    ...(config.mutationTimeout ? { mutationTimeout: config.mutationTimeout } : {}),
    ...(config.replicaTimeout ? { replicaTimeout: config.replicaTimeout } : {}),
    ...(config.cutoverTimeout ? { cutoverTimeout: config.cutoverTimeout } : {}),
    ...(config.stack ? { stack: config.stack } : {}),
    ...(config.ownershipEnv ? { ownershipEnv: config.ownershipEnv } : {}),
    ...(config.path && config.path !== "." ? { cwd: config.path } : {}),
    ...(keep ? { keepOnFailure: true } : {}),
  };
  const a = args as unknown as Record<string, unknown>;
  const swapGate = config.gate?.gate ?? `approve-${config.name}`;
  const dropGate = config.dropGate?.gate ?? `approve-${config.name}-drop`;
  const policy = config.gate?.approval?.policy;

  const step = (fn: string, extra: Partial<StepDefinition & { id: string; outcomeAttribute: unknown; profile: string; timeout: string }> = {}): StepDefinition =>
    ({ ...activity(fn, a), ...extra }) as StepDefinition;

  // The swap waits for this gate, unless the caller holds the approval (`gates: "outer"`).
  const approve = phase("Approve", [
    gate(swapGate, {
      ...(config.gate?.timeout ? { timeout: config.gate.timeout } : {}),
      plan: stepOutput("verify", "planDigest"),
      description:
        config.gate?.description ??
        `Approve swapping the rebuilt ${config.table} in on ${config.env}: the run record's Verification line has the counts this approval binds`,
      ...(config.gate?.approval
        ? {
            approval: {
              ...config.gate.approval,
              ...(policy
                ? {
                    context: {
                      verifiedPartitions: stepOutput("verify", "partitions"),
                      verifiedRows: stepOutput("verify", "rows"),
                      ...config.gate.approval.context,
                    },
                  }
                : {}),
            },
          }
        : {}),
    }),
  ]);

  const phases = [
    ...(config.build === false ? [] : [phase("Build", [activity("chantBuild", { path: config.path ?? "." })])]),
    phase("Plan", [step("clickhouseRebuildPlan", { id: "plan", outcomeAttribute: { name: "RebuildState", from: "state" } })]),
    phase("Create", [step("clickhouseRebuildCreate")]),
    phase("Dual write", [
      config.dualWrite.mode === "app"
        ? gate(config.writesGate?.gate ?? `${config.name}-writes-stopped`, {
            ...(config.writesGate?.timeout ? { timeout: config.writesGate.timeout } : {}),
            description:
              config.writesGate?.description ??
              `Stop the application's writes to ${config.table} (pause or buffer them) and approve; they resume against ${config.table} after the swap`,
          })
        : step("clickhouseRebuildDualWrite", { outcomeAttribute: { name: "Cutover", from: "cutover" } }),
    ]),
    phase("Backfill", [step("clickhouseRebuildBackfill", { profile: "fastIdempotent", timeout: config.backfillTimeout ?? "6h", outcomeAttribute: [{ name: "Copied", from: "copied" }, { name: "Skipped", from: "skipped" }] })]),
    phase("Verify", [
      step("clickhouseRebuildVerify", {
        id: "verify",
        outcomeAttribute: [
          { name: "Verification", from: "summary" },
          { name: "VerifiedPartitions", from: "partitions" },
          { name: "VerifiedRows", from: "rows" },
        ],
      }),
    ]),
    ...(outer ? [] : [approve]),
    phase("Swap", [step("clickhouseRebuildSwap", { profile: "longInfra", outcomeAttribute: { name: "Dependents", from: "dependents" } })]),
    phase("Retain", [step("clickhouseRebuildRetain", { id: "retain", outcomeAttribute: { name: "RetainUntil", from: "retainUntil" } })]),
    ...(outer
      ? []
      : [
          phase("Approve drop", [
            gate(dropGate, {
              ...(config.dropGate?.timeout ? { timeout: config.dropGate.timeout } : {}),
              plan: stepOutput("retain", "dropDigest"),
              description: config.dropGate?.description ?? `Approve dropping the old ${config.table} once its retention has passed`,
            }),
          ]),
          phase("Drop", [step("clickhouseRebuildDrop", { outcomeAttribute: { name: "Dropped", from: "dropped" } })]),
        ]),
  ];

  const op = Op({
    name: config.name,
    overview: `Rebuild ${config.table} on ${config.env}: new table, ${config.dualWrite.mode === "app" ? "writes stopped" : "dual write"}, backfill, verify, ${outer ? "swap under the caller's approval" : "gated swap"}`,
    labels: { Rebuild: "true", Env: config.env, Table: config.table },
    phases,
    ...(keep ? {} : { onFailure: [phase("Compensate", [step("clickhouseRebuildCompensate")])] }),
  });
  return { op };
}
