/**
 * `PostgresMigrationOp` (#3281): the column change Postgres cannot make in
 * place without breaking readers (a rename, SQLPG205; a type change across
 * kinds, SQLPG208), run as expand and contract in a gated composite Op. A
 * type change within a kind that rewrites the table under ACCESS EXCLUSIVE
 * (SQLPG207) can run as the same Op, which fills the new column in batches
 * instead.
 *
 *     export const { op } = PostgresMigrationOp({
 *       name: "migrate-app-users-login",
 *       env: "prod",
 *       table: "app.users",
 *       column: "login",
 *     });
 *
 * | Phase | Step |
 * |---|---|
 * | Build | `chant build` (`build: false` skips it) |
 * | Plan | classify the column's change against the server; refuse what the Op does not make |
 * | Expand | add the new column, nullable, no default (a catalog change) |
 * | Dual write | a trigger that keeps the new column written: computed from the old one for a type change, both ways for a rename |
 * | Backfill | `UPDATE` per key range, each batch with its receipt in its own transaction, under `lock_timeout`, pausing while a replica is behind |
 * | Carry over | each index on the old column built again on the new one `CONCURRENTLY`, each check and foreign key (another table's too) added `NOT VALID` and validated (`./carry.ts`) |
 * | Verify | rows, mismatches and checksums of the new column against the old |
 * | Approve | a gate bound to the plan and the verified new column |
 * | Switch | NOT NULL proven by a validated check; then one short transaction: a type change swaps the columns by name, a rename finishes the new column; the carried indexes and constraints take their names (keys `USING INDEX`), and the views that read the column are made again from their declarations |
 * | Retain | the old column, until `retain` has passed |
 * | Approve contract | a gate bound to that old column |
 * | Contract | drop the old column (and a rename's trigger) once its date has passed |
 * | onFailure | drop what the expand added: the trigger, its function, the check, the new column, the receipts |
 *
 * Run it until it is done: each run goes as far as the next gate. Every step
 * re-reads the server, so a run after a gate, a crash or an approval picks up
 * where the last stopped. A run killed during the backfill (Ctrl-C, a lost
 * machine) is not a failure, runs no onFailure, and the next run resumes the
 * backfill from its receipts; a step that fails runs onFailure, and the next
 * run starts again from a new column.
 *
 * `gates: "outer"` (#3687) leaves out both approval gates and the Contract
 * phase, for a caller that runs the Op under an approval of its own: the run
 * goes from Plan to Retain, verification included. `onFailure: "keep"`
 * leaves out the onFailure, so a failed run's next run resumes the backfill
 * from its receipts instead of starting again.
 */

import { Op, activity, gate, phase, stepOutput, type GateApproval } from "@intentius/chant/op";
import type { OpResource } from "@intentius/chant/op";
import type { StepDefinition } from "@intentius/chant/op";
import { parseDuration } from "@intentius/chant/op";

export interface PostgresMigrationOpConfig {
  /** Op name (kebab-case). */
  name: string;
  /** The chant environment: selects `sql.profiles.<env>`. */
  env: string;
  /** The table, `schema.name` as the server knows it (or its export name). */
  table: string;
  /** The column as the build declares it: the new name for a rename. */
  column: string;
  /**
   * A type change: the SQL expression that computes the new value from the
   * old row's columns, as `ALTER COLUMN ... TYPE ... USING` takes it. Default:
   * `CAST(<column> AS <declared type>)`. The backfill, the dual-write trigger
   * and the verification all use it.
   */
  using?: string;
  /** The build output the declaration is read from. Default: `dist/schema.json`. */
  output?: string;
  /** Project directory to build. Default: `.`. */
  path?: string;
  /** Run `chant build` first (the project's `build` script). Default: true. */
  build?: boolean;
  /** How long the old column is kept after the switch, as a duration (`7d`, `36h`). Default: `7d`. */
  retain?: string;
  /**
   * Rows per batch: the width of a batch's range of a primary key of one
   * integer column, or how many keys lie between two recorded boundaries of
   * any other key (uuid, text, several columns). Default: 1000.
   */
  batchSize?: number;
  /**
   * Pause the backfill while a replica's replay lag is above `max`, for up to
   * `wait` at a time. Default: `{ max: "10s", wait: "30m" }`. `false` turns
   * the check off.
   */
  replicationLag?: { max?: string; wait?: string } | false;
  /** `lock_timeout` for every statement, in ms. Default: the profile's `lockTimeoutMs`, else 5000. */
  lockTimeoutMs?: number;
  /** `statement_timeout` for every statement but the scans (validation, verification), in ms. Default: the profile's `statementTimeoutMs`, else 60000. */
  statementTimeoutMs?: number;
  /** The gate before the switch. Default name `approve-<name>`. */
  gate?: {
    gate?: string;
    timeout?: string;
    description?: string;
    /** Quorum, roles and a policy (#2508). With a policy, the verification's counts are added to its context. */
    approval?: GateApproval;
  };
  /** The gate before the old column is dropped. Default name `approve-<name>-contract`. */
  contractGate?: { gate?: string; timeout?: string; description?: string };
  /** One attempt of the backfill step. Default: `6h`, the longest a step may run. */
  backfillTimeout?: string;
  /** Ownership stack. Default: `ownership.stack` in `chant.config.ts`. */
  stack?: string;
  /** Ownership env. Default: `ownership.env` in `chant.config.ts`. */
  ownershipEnv?: string;
  /**
   * Whose approval the switch and the contract wait for. `"own"` (the
   * default): the Op's two gates. `"outer"`: an approval the caller already
   * holds for a larger change that runs this Op as one of its steps. The
   * switch gate, the contract gate and the Contract phase are left out, so
   * the Op ends at Retain with the old column kept until its retention date.
   * Drop it after that date, or run the Op with `"own"`: its switch gate has
   * nothing left to switch, and its contract gate binds that old column. The
   * verification still runs, and any difference fails the run with nothing
   * switched.
   */
  gates?: "own" | "outer";
  /**
   * What a failed run does with what the expand added. `"drop"` (the
   * default): onFailure drops the new column, the dual-write trigger and the
   * receipts, and the next run starts again from a new column. `"keep"`:
   * there is no onFailure, and the next run resumes the backfill from its
   * per-batch receipts. To start again instead, run the Op once with
   * `"drop"`.
   */
  onFailure?: "drop" | "keep";
}

export interface PostgresMigrationOpResources {
  op: InstanceType<typeof OpResource>;
}

/** The arguments every migration activity takes. */
export interface PostgresMigrationArgs {
  table: string;
  column: string;
  buildPath: string;
  environment?: string;
  using?: string;
  retain?: string;
  batchSize?: number;
  replicationLag?: { max?: string; wait?: string } | false;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  stack?: string;
  ownershipEnv?: string;
  cwd?: string;
  /** A failed run keeps what the expand added (`onFailure: "keep"`): a refusal says how to start again. */
  keepOnFailure?: boolean;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$|^"(?:[^"]|"")+"$/;

export function PostgresMigrationOp(config: PostgresMigrationOpConfig): PostgresMigrationOpResources {
  const parts = config.table.split(".");
  if (parts.length > 2 || !parts.every((p) => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(p))) {
    throw new Error(`PostgresMigrationOp "${config.name}": table must be "schema.name" or an export name, got ${JSON.stringify(config.table)}`);
  }
  if (!config.column || !IDENT.test(config.column)) throw new Error(`PostgresMigrationOp "${config.name}": column must be the declared column's name, got ${JSON.stringify(config.column)}`);
  if (config.batchSize !== undefined && (!Number.isInteger(config.batchSize) || config.batchSize < 1)) {
    throw new Error(`PostgresMigrationOp "${config.name}": batchSize must be a positive integer, got ${config.batchSize}`);
  }
  if (config.replicationLag) for (const d of [config.replicationLag.max, config.replicationLag.wait]) if (d !== undefined) parseDuration(d);
  if (config.retain !== undefined) parseDuration(config.retain);
  if (config.gates !== undefined && config.gates !== "own" && config.gates !== "outer") {
    throw new Error(`PostgresMigrationOp "${config.name}": gates must be "own" or "outer"`);
  }
  if (config.onFailure !== undefined && config.onFailure !== "drop" && config.onFailure !== "keep") {
    throw new Error(`PostgresMigrationOp "${config.name}": onFailure must be "drop" or "keep"`);
  }
  const outer = config.gates === "outer";
  const keep = config.onFailure === "keep";

  const args: PostgresMigrationArgs = {
    table: config.table,
    column: config.column,
    buildPath: config.output ?? "dist/schema.json",
    environment: config.env,
    ...(config.using !== undefined ? { using: config.using } : {}),
    ...(config.retain ? { retain: config.retain } : {}),
    ...(config.batchSize !== undefined ? { batchSize: config.batchSize } : {}),
    ...(config.replicationLag !== undefined ? { replicationLag: config.replicationLag } : {}),
    ...(config.lockTimeoutMs !== undefined ? { lockTimeoutMs: config.lockTimeoutMs } : {}),
    ...(config.statementTimeoutMs !== undefined ? { statementTimeoutMs: config.statementTimeoutMs } : {}),
    ...(config.stack ? { stack: config.stack } : {}),
    ...(config.ownershipEnv ? { ownershipEnv: config.ownershipEnv } : {}),
    ...(config.path && config.path !== "." ? { cwd: config.path } : {}),
    ...(keep ? { keepOnFailure: true } : {}),
  };
  const a = args as unknown as Record<string, unknown>;
  const switchGate = config.gate?.gate ?? `approve-${config.name}`;
  const contractGate = config.contractGate?.gate ?? `approve-${config.name}-contract`;
  const policy = config.gate?.approval?.policy;
  const what = `${config.table}.${config.column}`;

  const step = (fn: string, extra: Partial<StepDefinition & { id: string; outcomeAttribute: unknown; profile: string; timeout: string }> = {}): StepDefinition =>
    ({ ...activity(fn, a), ...extra }) as StepDefinition;

  // The switch waits for this gate, unless the caller holds the approval (`gates: "outer"`).
  const approve = phase("Approve", [
    gate(switchGate, {
      ...(config.gate?.timeout ? { timeout: config.gate.timeout } : {}),
      plan: stepOutput("verify", "planDigest"),
      description:
        config.gate?.description ??
        `Approve switching ${what} on ${config.env}: the run record's Verification line has what this approval binds; for a rename, readers move to the new name once it is switched`,
      ...(config.gate?.approval
        ? {
            approval: {
              ...config.gate.approval,
              ...(policy
                ? {
                    context: {
                      verifiedRows: stepOutput("verify", "rows"),
                      mismatched: stepOutput("verify", "mismatched"),
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
    phase("Plan", [step("postgresMigrationPlan", { id: "plan", outcomeAttribute: [{ name: "MigrationState", from: "state" }, { name: "Change", from: "change" }] })]),
    phase("Expand", [step("postgresMigrationExpand")]),
    phase("Dual write", [step("postgresMigrationDualWrite")]),
    phase("Backfill", [
      step("postgresMigrationBackfill", {
        profile: "fastIdempotent",
        timeout: config.backfillTimeout ?? "6h",
        outcomeAttribute: [
          { name: "Filled", from: "filled" },
          { name: "Skipped", from: "skipped" },
          { name: "BackfilledRows", from: "rows" },
        ],
      }),
    ]),
    phase("Carry over", [
      step("postgresMigrationCarry", {
        timeout: "6h",
        outcomeAttribute: [
          { name: "Carried", from: "carried" },
          { name: "CarriedBuilt", from: "built" },
        ],
      }),
    ]),
    phase("Verify", [
      step("postgresMigrationVerify", {
        id: "verify",
        timeout: "6h",
        outcomeAttribute: [
          { name: "Verification", from: "summary" },
          { name: "VerifiedRows", from: "rows" },
        ],
      }),
    ]),
    ...(outer ? [] : [approve]),
    phase("Switch", [step("postgresMigrationSwitch", { timeout: "6h", outcomeAttribute: [{ name: "OldColumn", from: "oldColumn" }] })]),
    phase("Retain", [step("postgresMigrationRetain", { id: "retain", outcomeAttribute: { name: "RetainUntil", from: "retainUntil" } })]),
    ...(outer
      ? []
      : [
          phase("Approve contract", [
            gate(contractGate, {
              ...(config.contractGate?.timeout ? { timeout: config.contractGate.timeout } : {}),
              plan: stepOutput("retain", "contractDigest"),
              description: config.contractGate?.description ?? `Approve dropping the old column of ${what} once its retention has passed and no reader uses it`,
            }),
          ]),
          phase("Contract", [step("postgresMigrationContract", { outcomeAttribute: { name: "Dropped", from: "dropped" } })]),
        ]),
  ];

  const op = Op({
    name: config.name,
    overview: `Migrate ${what} on ${config.env} as expand and contract: new column, dual write, backfill, verify, ${outer ? "switch under the caller's approval" : "gated switch, gated contract"}`,
    labels: { Migration: "true", Env: config.env, Table: config.table, Column: config.column },
    phases,
    ...(keep ? {} : { onFailure: [phase("Compensate", [step("postgresMigrationCompensate")])] }),
  });
  return { op };
}
