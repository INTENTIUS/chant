/**
 * The row lease on the apply paths that plan inside their own steps (#4594):
 * `chant run --components`, `chant components fan-out`, a promote, a
 * rollback and a redeploy. `chant components pr-apply` and op waves lease the
 * rows their plan already knows (#4552); these paths plan only as each step
 * runs, so the lease is taken there, one step or one group at a time.
 *
 * - A step on the resource grain (`lockGrainBeforePlan`: the step's own
 *   `lockGrain`, else `ci.lockGrain`, else its lexicon's default) plans
 *   first, asks its lexicon for the rows of that plan, leases them, and then
 *   applies the plan it leased for, handed back as `DeployContext.plans`. A
 *   step on any other grain applies as before and takes no lease.
 * - A group (ws-107) leases the rows of every member's plan in one take
 *   before `runGroup` is called, and lets go once it returns.
 * - A held row fails the step, or every member of the group, with a record
 *   marked `held`, so the command exits 5 (`CHANT_EXIT.held`) and nothing of
 *   that step applied.
 * - A step on the `target` grain whose lexicon names its target's row
 *   (`targetLockRow`: a stock Pulumi stack, a Terraform root), or on the
 *   `repo` grain, waits for that row in the ledger's queue, oldest commit
 *   first, up to `CHANT_LOCK_WAIT` seconds (ruling for ci-products
 *   2026-10-28, "Ledger lock"), and at the deadline fails with
 *   {@link LockWaitTimeoutError}, held, exit 5. A step on the resource grain
 *   never waits.
 *
 * The port ({@link ledgerRowLease}) writes `_locks/rows/<gate>.json` through
 * ../lifecycle/resource-lock.ts with one holder for the whole run, and
 * counts each row within the process, so two components of one run that
 * change one object let go of its row only once both have ended.
 */
import type { LockGrain, LockRow } from "../lifecycle/lock-rows";
import { lockGrainBeforePlan, queueRowsOf, resolvePlannedLock, sortedLockRows } from "../lifecycle/lock-rows";
import type { LockLiveness, LockRowHolder } from "../lifecycle/resource-lock";
import type { Capability, CapabilityPlan, DeployContext } from "./capability";

/** Rows a step or a group holds while it applies. */
export interface RowLease {
  /** Let go of the rows. Never throws; false when the rows file could not be written, and the rows stay until a later apply takes them over. */
  release(): Promise<boolean>;
}

/** How a run takes its row leases (#4594). */
export interface RowLeasePort {
  /**
   * Lease `rows` for `label` (a component, or a group's components), all or
   * nothing. Throws {@link LockRowsHeldError} when another live run holds
   * one, and any other error when the rows file cannot be read or written.
   * With `wait`, waits in the queue for them instead, and throws
   * {@link LockWaitTimeoutError} at the deadline.
   */
  take(rows: readonly LockRow[], label: string, opts?: { wait?: boolean }): Promise<RowLease>;
}

/** Another live run holds a row this apply changes (#4594), so nothing of it applied. Exit 5. */
export class LockRowsHeldError extends Error {
  readonly lockRowsHeld = true;
  constructor(message: string) {
    super(message);
    this.name = "LockRowsHeldError";
  }
}

/** A wait for a target's row reached its deadline (ruling for ci-products 2026-10-28): nothing of the step applied. Exit 5, as a held row is. */
export class LockWaitTimeoutError extends LockRowsHeldError {
  constructor(message: string) {
    super(message);
    this.name = "LockWaitTimeoutError";
  }
}

/** Whether `err` is a held row ({@link LockRowsHeldError}), by its mark, so a copy from another bundle counts too. */
export function isLockRowsHeldError(err: unknown): err is LockRowsHeldError {
  return typeof err === "object" && err !== null && (err as { lockRowsHeld?: unknown }).lockRowsHeld === true;
}

const NO_LEASE: RowLease = { release: () => Promise.resolve(true) };

export interface LedgerRowLeaseOptions {
  cwd?: string;
  /** Whether a run holding rows still runs. Default: the forge's answer, with the lease's age. */
  alive?: LockLiveness;
  /** Who the rows name. Default: this CI run, else this host and process. */
  holder?: LockRowHolder;
  /** Where the lease's info lines go. Default stderr. */
  log?: (line: string) => void;
  /** How long a waiting take waits, in seconds. Default `CHANT_LOCK_WAIT`. */
  waitSeconds?: number;
  /** How often a waiting take reads the rows file again, in ms. Default `CHANT_LOCK_POLL` seconds, else 10 s. */
  pollMs?: number;
  /** The commit time that orders this run in the queue. Default: HEAD's in `cwd`. */
  commitAt?: string;
}

/**
 * The port over `gate`'s rows file on `chant/lifecycle` (#4594), one holder
 * for every take of the run. A row this process already holds for another
 * step is counted, not taken again, and is let go of when its last holder in
 * the process ends.
 */
export function ledgerRowLease(gate: string, opts: LedgerRowLeaseOptions = {}): RowLeasePort {
  const counts = new Map<string, number>();
  const log = opts.log ?? ((line: string) => console.error(line));
  let holder: LockRowHolder | undefined = opts.holder;
  const lock = () => import("../lifecycle/resource-lock");
  return {
    async take(rows, label, takeOpts) {
      const wanted = sortedLockRows(rows);
      if (wanted.length === 0) return NO_LEASE;
      const { commitTimeOf, leaseLockRows, lockPollMs, lockRowHolder, lockWaitSeconds, releaseLockRows } = await lock();
      holder ??= lockRowHolder(process.env);
      const fresh = wanted.filter((r) => (counts.get(r.key) ?? 0) === 0);
      if (fresh.length > 0) {
        const commitAt = takeOpts?.wait ? (opts.commitAt ?? (await commitTimeOf(holder.sha ?? "HEAD", opts.cwd))) : undefined;
        const wait = takeOpts?.wait
          ? {
              wait: {
                deadline: Date.now() + (opts.waitSeconds ?? lockWaitSeconds(process.env)) * 1000,
                pollMs: opts.pollMs ?? lockPollMs(process.env),
                log: (line: string) => log(`${label}: ${line}`),
                ...(commitAt ? { commitAt } : {}),
              },
            }
          : {};
        const leased = await leaseLockRows(gate, fresh, { holder, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.alive ? { alive: opts.alive } : {}), ...wait });
        if (!leased.ok && leased.timedOut) throw new LockWaitTimeoutError(`${label}: LockWaitTimeoutError: ${leased.message}, so nothing of it was applied.`);
        if (!leased.ok) {
          throw new LockRowsHeldError(
            `${label}: ${leased.message}, so nothing of it was applied. Apply again once that run ends; a run that is gone, or whose lease is older than CHANT_LOCK_STALE seconds, is taken over.`,
          );
        }
        for (const h of leased.tookOver) log(`${label}: took over the rows of run ${h.run}, which is gone`);
      }
      for (const r of wanted) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
      log(`${label}: holds ${wanted.length} row${wanted.length === 1 ? "" : "s"} of ${gate} while it applies`);
      const me = holder.run;
      let released = false;
      return {
        async release() {
          if (released) return true;
          released = true;
          const free: string[] = [];
          for (const r of wanted) {
            const n = (counts.get(r.key) ?? 1) - 1;
            if (n <= 0) {
              counts.delete(r.key);
              free.push(r.key);
            } else {
              counts.set(r.key, n);
            }
          }
          if (free.length === 0) return true;
          const ok = await releaseLockRows(gate, free, me, { ...(opts.cwd ? { cwd: opts.cwd } : {}) });
          if (!ok) log(`${label}: could not let go of the rows it held; the next apply takes them over once this run is gone`);
          return ok;
        },
      };
    },
  };
}

/**
 * Lease one capability step's rows (#4594) when `ctx.rowLease` is set, the
 * step was handed no plan and its grain is `resource`: plan, read the rows
 * of that plan, lease them, and return the context that applies the leased
 * plan. Otherwise the context as given and no lease. A grain the lexicon
 * refuses throws, as it does at plan in a pull request.
 */
export async function leaseCapabilityStep(
  capability: Capability<never, unknown>,
  ctx: DeployContext,
  input: unknown,
): Promise<{ ctx: DeployContext; lease: RowLease }> {
  const port = ctx.rowLease;
  if (!port) return { ctx, lease: NO_LEASE };
  const grain = await lockGrainBeforePlan(capability, input, ctx.lockGrain);
  if (grain !== "resource") {
    // The ruling for ci-products (2026-10-28): the target's row (or the repo row), waited for, whether or not a plan was handed in.
    const queue = await queueRowsOf(capability, input, ctx.component, grain);
    return { ctx, lease: queue.length > 0 ? await port.take(queue, ctx.component, { wait: true }) : NO_LEASE };
  }
  if (ctx.plans !== undefined || !capability.plan) return { ctx, lease: NO_LEASE };
  const planned: CapabilityPlan = await capability.plan(ctx, input as never);
  const lock = await resolvePlannedLock(capability, input, planned, ctx.lockGrain);
  const plans = planned.artifact !== undefined ? { [planned.member]: planned.artifact } : undefined;
  const applies: DeployContext = plans ? { ...ctx, plans } : ctx;
  if (lock.grain !== "resource" || lock.rows.length === 0) return { ctx: applies, lease: NO_LEASE };
  return { ctx: applies, lease: await port.take(lock.rows, ctx.component) };
}

/**
 * The rows of a group's approved plans (#4594), each member's from its
 * lexicon on its grain: what one take holds for the whole group.
 */
export async function groupLockRows(
  capability: Capability<never, unknown>,
  members: ReadonlyArray<{ component: string; input?: unknown; ctx: DeployContext }>,
  plans: Readonly<Record<string, CapabilityPlan>>,
  declared: LockGrain | undefined,
): Promise<LockRow[]> {
  const rows: LockRow[] = [];
  for (const m of members) {
    const plan = plans[m.component];
    if (!plan) continue;
    const lock = await resolvePlannedLock(capability, m.input, plan, declared);
    if (lock.grain === "resource") rows.push(...lock.rows);
  }
  return sortedLockRows(rows);
}
