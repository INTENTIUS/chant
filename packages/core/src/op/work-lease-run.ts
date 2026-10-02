/**
 * An Op run under a work item's lease (#2748, the Steward's gap 4 in #2731).
 *
 * An Op that declares `workLease` (`./types.ts`) runs its steps under the work
 * lease of one work item (`../lifecycle/work-lease.ts`, ws-055). The local
 * executor (`./local-executor.ts`) drives the {@link RunWorkLease} here:
 *
 * - Claim. Before the first step when the item is a literal or named by the
 *   run (`chant run <op> --work <id>`); right after the producing step when
 *   the item is a reference to a step's output. A list of candidates is tried
 *   in order and the first one nobody holds is taken. When nothing can be
 *   claimed the run ends `ok` with its remaining steps skipped, and the claim's
 *   record carries the refusal, which names who holds the item.
 * - Heartbeat. While the steps run, the lease is renewed every third of its
 *   time to live, keeping its fencing token. A renewal the lease refuses (it
 *   ran out and someone else claimed it, or it was released) means the lease
 *   is lost: the in-flight step's abort signal fires, no further step starts,
 *   and the run fails with `lease-lost`. A renewal that fails for any other
 *   reason (the remote didn't answer) is retried at the next beat; if that
 *   goes on past the expiry, the next renewal is refused and the lease is lost
 *   then. These are the semantics of chud's dispatcher
 *   (packages/runtime/src/dispatch.mjs), which this replaces.
 * - Fence. Before the run's record is written, one last renewal checks that
 *   the lease is still this run's, with the same token. Refused, the run is
 *   recorded as failed with `lease-lost`, never as done.
 * - Release. When the run ends, the lease is given back with the run's
 *   outcome (`done`, `not_done`, `gated`, or the Op's own `outcome`), which
 *   lands on `_leases/<id>.jsonl`. A lost lease is not released: it isn't
 *   this run's to give back.
 *
 * Steps read the lease through {@link workLeaseOutput}: its item, holder,
 * token and expiry, and for an Op that changes the checkout, the worktree and
 * branch it works in. An activity that writes somewhere a token can fence
 * (another ledger, a remote) passes the token along.
 *
 * ## Changing the checkout
 *
 * An Op with `changesCheckout` (applying a build, `chant workspace upgrade`)
 * must declare `workLease`, and its leased steps get a git worktree of their
 * own: `chant/work/<item>` checked out under the repository's git directory,
 * from the checkout's HEAD, or from the branch as an earlier run left it. The
 * worktree is removed when the run ends and the branch keeps whatever the
 * steps committed, for the runner to deliver. The checkout a coding agent is
 * editing, its index and its uncommitted files, are never touched.
 */

import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getRuntime } from "../runtime-adapter";
import {
  claimWorkLease,
  DEFAULT_WORK_LEASE_TTL_MS,
  releaseWorkLease,
  renewWorkLease,
  workLeaseRef,
  WORK_ITEM_ID_PATTERN,
  type WorkLease,
} from "../lifecycle/work-lease";
import { resolveMemberLedger } from "../lifecycle/member-ledger";
import { currentHolderId } from "../lifecycle/lease";
import { parseDuration } from "./duration";
import { isStepOutputRef, stepOutput, type StepOutputRef } from "./step-output-ref";
import { WORK_LEASE_STEP_ID, type OpConfig } from "./types";

export { WORK_LEASE_STEP_ID } from "./types";
export { workLeaseProblems, workLeaseNeedsRunItem } from "./work-lease-decl";

/** Why a run under a work lease failed when the lease was lost: chud's reason, kept. */
export const LEASE_LOST = "lease-lost";

/** The branch prefix an Op that changes the checkout works on. */
export const WORK_BRANCH_PREFIX = "chant/work/";

/** What a run's steps read about its work lease, via {@link workLeaseOutput}. */
export interface WorkLeaseOutput {
  item: string;
  holder: string;
  /** The fencing token: the same for the whole run unless the lease is lost. */
  token: string;
  acquiredAt: string;
  expiresAt: string;
  /** The lease ref. */
  ref: string;
  /** For an Op that changes the checkout: the worktree its steps work in. Otherwise null. */
  worktree: string | null;
  /** For an Op that changes the checkout: the worktree's branch. Otherwise null. */
  branch: string | null;
}

/** How a run's work lease ended, on `OpRunResult.workLease`. */
export interface WorkLeaseRunResult {
  /** The item claimed, or null when the run claimed nothing. */
  item: string | null;
  holder: string;
  token: string | null;
  /** The branch an Op that changes the checkout worked on, or null. */
  branch: string | null;
  /** Whether the lease was given back. False when it was lost, or never claimed. */
  released: boolean;
  /** The outcome the release recorded, or null when there was no release. */
  outcome: string | null;
  /** Why the lease was lost, or null when it wasn't. */
  lost: string | null;
  /** Why nothing was claimed, or null when something was. */
  refusal: string | null;
}

/**
 * A reference to the run's work lease, for a step's args:
 * `workLeaseOutput("token")`, `workLeaseOutput("worktree")`, or the whole
 * {@link WorkLeaseOutput} with no path.
 */
export function workLeaseOutput(path?: keyof WorkLeaseOutput): StepOutputRef {
  return stepOutput(WORK_LEASE_STEP_ID, path);
}

/**
 * The holder a steward's turn claims work leases as:
 * `<steward>/<op>@<process>`. `chant workspace status --json` reads it back
 * to show the lease a steward's current turn holds beside its Ops.
 */
export function stewardWorkHolder(steward: string, op: string, process: string = currentHolderId()): string {
  return `${steward}/${op}@${process}`;
}

function resolvePath(value: unknown, path?: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]), value);
}

async function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const out = await getRuntime().spawn(["git", ...args], { cwd });
  return { ok: out.exitCode === 0, stdout: out.stdout.trim(), stderr: out.stderr.trim() };
}

/** What a claim attempt came to, for the executor to record. */
export type WorkClaimOutcome =
  | { kind: "claimed"; lease: WorkLeaseOutput; tried: string[] }
  /** Nothing to claim, or every candidate is held. `refusal` says which. */
  | { kind: "unclaimed"; refusal: string; tried: string[] };

export interface RunWorkLeaseOptions {
  /** The project directory: where the run's ledger is, and what `workLease.kind` is relative to. */
  cwd: string;
  holder?: string;
  /** The item the run names (`--work`), which takes the place of the Op's own. */
  item?: string;
  /** Called with a renewal's error that didn't lose the lease, which the next beat retries. */
  onRenewError?: (message: string) => void;
}

/** One run's hold on one work item's lease. Created by the executor for an Op with `workLease`. */
export class RunWorkLease {
  readonly holder: string;
  readonly ttlMs: number;
  /** Aborts when the lease is lost, so the step in flight stops. */
  readonly lostSignal: AbortSignal;
  /** Set once the claim was made or given up on. */
  attempted = false;
  lease: WorkLeaseOutput | undefined;
  refusal: string | undefined;
  lost: string | undefined;

  private readonly spec: NonNullable<OpConfig["workLease"]>;
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private beat: Promise<void> | undefined;

  constructor(
    private readonly config: Pick<OpConfig, "name" | "workLease" | "changesCheckout">,
    private readonly opts: RunWorkLeaseOptions,
  ) {
    if (!config.workLease) throw new Error(`Op "${config.name}" declares no workLease`);
    this.spec = config.workLease;
    this.holder = opts.holder ?? currentHolderId();
    this.ttlMs = this.spec.ttl ? parseDuration(this.spec.ttl) : DEFAULT_WORK_LEASE_TTL_MS;
    this.lostSignal = this.abort.signal;
  }

  /** The directory whose ledger holds the lease: the kind file's, or the project's. */
  private get ledgerCwd(): string {
    const kind = this.spec.kind;
    if (!kind) return this.opts.cwd;
    const file = isAbsolute(kind) ? kind : resolve(this.opts.cwd, kind);
    return resolve(file, "..");
  }

  /** Whether the claim is due at a step boundary, given the results so far. */
  due(resultsById: ReadonlyMap<string, unknown>): boolean {
    if (this.attempted) return false;
    if (this.opts.item !== undefined) return true;
    const item = this.spec.item;
    return !isStepOutputRef(item) || resultsById.has(item.step);
  }

  /** The candidate ids, in order. Empty when the reference resolved to nothing. */
  private candidates(resultsById: ReadonlyMap<string, unknown>): string[] {
    if (this.opts.item !== undefined) return [this.opts.item];
    const item = this.spec.item;
    const value = isStepOutputRef(item) ? resolvePath(resultsById.get(item.step), item.path) : item;
    if (value === undefined || value === null || value === "") return [];
    const list = Array.isArray(value) ? value : [value];
    return list.filter((v) => v !== undefined && v !== null && v !== "").map((v) => {
      if (typeof v !== "string" || !WORK_ITEM_ID_PATTERN.test(v) || v.includes("..")) {
        throw new Error(`Op "${this.config.name}": workLease.item resolved to ${JSON.stringify(v)}, which can't key a work lease`);
      }
      return v;
    });
  }

  /**
   * Claim the first candidate nobody holds. On a claim, the heartbeat starts,
   * and for an Op that changes the checkout its worktree is made. Throws when
   * the claim could not be made for a reason other than someone holding it
   * (git failed): the run fails, as for any failing step.
   */
  async claim(resultsById: ReadonlyMap<string, unknown>): Promise<WorkClaimOutcome> {
    this.attempted = true;
    const tried = this.candidates(resultsById);
    if (tried.length === 0) {
      this.refusal = "nothing to claim: the work item resolved to no id";
      return { kind: "unclaimed", refusal: this.refusal, tried };
    }
    const refused: string[] = [];
    for (const id of tried) {
      const result = await claimWorkLease(id, this.holder, { cwd: this.ledgerCwd, ttlMs: this.ttlMs, note: `op ${this.config.name}` });
      if (!result.ok) {
        refused.push(`${result.reason}: ${result.message}`);
        continue;
      }
      const { prefix, members } = await resolveMemberLedger(this.ledgerCwd);
      const lease: WorkLeaseOutput = {
        ...pick(result.lease),
        ref: workLeaseRef(id, prefix),
        worktree: null,
        branch: null,
      };
      this.lease = lease;
      if (this.config.changesCheckout) {
        try {
          const made = await this.makeWorktree(id, members);
          lease.worktree = made.worktree;
          lease.branch = made.branch;
        } catch (err) {
          await releaseWorkLease(id, this.holder, { cwd: this.ledgerCwd, token: lease.token, outcome: "not_done", note: "the worktree could not be made" }).catch(() => undefined);
          this.lease = undefined;
          throw err;
        }
      }
      this.startHeartbeat();
      return { kind: "claimed", lease, tried };
    }
    this.refusal = refused.join("; ");
    return { kind: "unclaimed", refusal: this.refusal, tried };
  }

  /**
   * A worktree for `id` on `chant/work/[<member>/]<id>`, under the git
   * directory so the checkout's own `git status` never lists it. Starts from
   * the branch when an earlier run left it, from HEAD otherwise.
   */
  private async makeWorktree(id: string, members: readonly string[]): Promise<{ worktree: string; branch: string }> {
    const cwd = this.opts.cwd;
    const common = await git(["rev-parse", "--git-common-dir"], cwd);
    if (!common.ok) throw new Error(`Op "${this.config.name}" changes the checkout, but ${cwd} is not a git checkout: ${common.stderr}`);
    const commonDir = isAbsolute(common.stdout) ? common.stdout : resolve(cwd, common.stdout);
    const scope = members.join("/");
    const branch = `${WORK_BRANCH_PREFIX}${scope ? `${scope}/` : ""}${id}`;
    const worktree = join(commonDir, "chant-work", ...members, id);
    if (existsSync(worktree)) {
      await git(["worktree", "remove", "--force", worktree], cwd);
      rmSync(worktree, { recursive: true, force: true });
    }
    await git(["worktree", "prune"], cwd);
    const exists = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd)).ok;
    const add = exists
      ? await git(["worktree", "add", "--quiet", worktree, branch], cwd)
      : await git(["worktree", "add", "--quiet", "-b", branch, worktree, "HEAD"], cwd);
    if (!add.ok) throw new Error(`Op "${this.config.name}": could not make the worktree for ${id} on ${branch}: ${add.stderr}`);
    return { worktree, branch };
  }

  private lose(why: string): void {
    if (this.lost !== undefined) return;
    this.lost = why;
    this.stopHeartbeat();
    this.abort.abort(new Error(`${LEASE_LOST}: ${why}`));
  }

  /** One renewal. Refused, the lease is lost; failed otherwise, the next beat retries. */
  private async renew(): Promise<void> {
    const lease = this.lease;
    if (!lease || this.lost !== undefined) return;
    try {
      const result = await renewWorkLease(lease.item, this.holder, { cwd: this.ledgerCwd, ttlMs: this.ttlMs, token: lease.token });
      if (result.ok) {
        lease.expiresAt = result.lease.expiresAt;
        return;
      }
      // The remote refusing the push is the lease held elsewhere only when it
      // says who holds it; unreachable, the next beat tries again.
      if (result.reason === "lease-push-rejected" && !result.heldBy) {
        this.opts.onRenewError?.(result.message);
        return;
      }
      if (result.reason === "lease-race") {
        this.opts.onRenewError?.(result.message);
        return;
      }
      this.lose(result.message);
    } catch (err) {
      this.opts.onRenewError?.(err instanceof Error ? err.message : String(err));
    }
  }

  private startHeartbeat(): void {
    const every = Math.max(1_000, Math.floor(this.ttlMs / 3));
    this.timer = setInterval(() => {
      if (this.beat) return;
      this.beat = this.renew().finally(() => {
        this.beat = undefined;
      });
    }, every);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * The last renewal before the run's record is written, after the heartbeat
   * stops. Returns whether the lease is still this run's.
   */
  async fence(): Promise<boolean> {
    if (!this.lease) return this.lost === undefined;
    this.stopHeartbeat();
    await this.beat;
    if (this.lost !== undefined) return false;
    const lease = this.lease;
    try {
      const result = await renewWorkLease(lease.item, this.holder, { cwd: this.ledgerCwd, ttlMs: this.ttlMs, token: lease.token });
      if (result.ok) lease.expiresAt = result.lease.expiresAt;
      else this.lose(result.message);
    } catch (err) {
      this.lose(`the lease could not be renewed before the run was recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.lost === undefined;
  }

  /**
   * End the run's hold: stop the heartbeat, remove the worktree (the branch
   * keeps what was committed), and give the lease back with the outcome
   * unless it was lost.
   */
  async finish(status: "ok" | "fail" | "gated" | "waiting", resultsById: ReadonlyMap<string, unknown>): Promise<WorkLeaseRunResult> {
    this.stopHeartbeat();
    await this.beat;
    const lease = this.lease;
    const base: WorkLeaseRunResult = {
      item: lease?.item ?? null,
      holder: this.holder,
      token: lease?.token ?? null,
      branch: lease?.branch ?? null,
      released: false,
      outcome: null,
      lost: this.lost ?? null,
      refusal: this.refusal ?? null,
    };
    if (!lease) return base;
    if (lease.worktree) {
      await git(["worktree", "remove", "--force", lease.worktree], this.opts.cwd).catch(() => undefined);
      rmSync(lease.worktree, { recursive: true, force: true });
      await git(["worktree", "prune"], this.opts.cwd).catch(() => undefined);
    }
    if (this.lost !== undefined) return base;
    let outcome = status === "ok" ? "done" : status === "gated" || status === "waiting" ? status : "not_done";
    if (status === "ok" && this.spec.outcome && isStepOutputRef(this.spec.outcome)) {
      const declared = resolvePath(resultsById.get(this.spec.outcome.step), this.spec.outcome.path);
      if (typeof declared === "string" && declared.trim() !== "") outcome = declared.trim();
    }
    const released = await releaseWorkLease(lease.item, this.holder, {
      cwd: this.ledgerCwd,
      token: lease.token,
      outcome,
      note: `op ${this.config.name}`,
    }).catch(() => undefined);
    return { ...base, released: released?.ok === true, outcome: released?.ok ? outcome : null };
  }
}

function pick(lease: WorkLease): Omit<WorkLeaseOutput, "ref" | "worktree" | "branch"> {
  return { item: lease.item, holder: lease.holder, token: lease.token, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt };
}
