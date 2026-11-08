/**
 * A state migration behind a gated request (#4762): new states for several
 * roots or stacks, proved before anyone approves them, written once someone
 * other than the requester approved that proof, under every state's lock,
 * and checked again after the write.
 *
 * Engine-neutral. The engine plans the migration (each root's state before,
 * its new state's digest, and a proof that the root plans no change against
 * it) and supplies a {@link StateMigrationEngine} for the write: take the
 * locks, read a root's state now, write the new states, and plan each root
 * again against its real state. The terraform lexicon plans moves of
 * resources between roots and reverts to a recorded version
 * (`@intentius/chant-lexicon-terraform/state-migration`); a move of
 * resources between Pulumi stacks fits the same calls. The product passes
 * its words: the op, the migration's name, the approve command, and the
 * facts its own history reads back.
 *
 *   1. A plan whose proof shows a change is refused before anything is
 *      asked (`proof-failed`).
 *   2. The request (kind `migrate`, subject the migration's name) carries
 *      the plan as its attachment, so its digest binds every root's state
 *      before and after. A state that moves before the approval asks again.
 *   3. Approved, the approval is spent, every lock is taken, and each root's
 *      state is read again. A state that is not the one planned refuses the
 *      write (`moved`), with nothing written.
 *   4. The new states are written, every root plans against its real state,
 *      and a change left anywhere fails the migration. The locks are
 *      released whatever happens. The finished line holds each root's
 *      location and its version and digest before and after, never a
 *      state's contents.
 */
import { CHANT_EXIT } from "./exit-codes";
import { gatedOp, type GatedRequestLedger } from "./lifecycle/gated-op";
import type { GatedRequestRules } from "./lifecycle/gated-request";

/** The first chant with the engine-neutral state migration (#4762). */
export const STATE_MIGRATION_FLOOR = "0.124.77";

/** A state as a migration binds it: its version id, when the store keeps versions, and its digest, null for no state. */
export interface MigrationStateAt {
  version_id?: string;
  digest: string | null;
}

/** What a plan of a root against a state found. */
export interface MigrationCheck {
  /** Each change, as `<address>: <actions>`. None: the root plans clean. */
  changes: string[];
  /** The engine's own summary line. */
  summary: string;
}

/** One root of a migration's plan: never its state's contents. */
export interface MigrationRootPlan {
  root: string;
  /** Where its state is, as the record names it. */
  location?: string;
  before: MigrationStateAt;
  /** The new state's digest, and its version id once written. */
  after: { digest: string; version_id?: string };
  /** The plan against the new state, before anything is written. */
  proof: MigrationCheck;
  /** The plan against the real state, after the write. */
  verify?: MigrationCheck;
}

/** The engine's half of a migration's write. */
export interface StateMigrationEngine {
  /** Take the lock of every state the migration writes or reads. Throws when one is held, having released what it took. Answers the release. */
  lock(): Promise<() => Promise<void>>;
  /** A root's state now, read under the locks. */
  current(root: string): Promise<MigrationStateAt>;
  /** Write every new state, in the engine's order. Throws at the first that fails. */
  write(): Promise<void>;
  /** After the write: the root planned against its real state, its version now, and its version before when only the write named it (a snapshot). */
  verify(root: string): Promise<MigrationCheck & { version_id?: string; before_version_id?: string }>;
}

/** The product's words for a migration. */
export interface StateMigrationWords {
  /** The op the requests wait at, such as `tf-migrate`. */
  op: string;
  /** The request's kind. Default `migrate`. */
  kind?: string;
  approveCommand?: (subject: string, digest: string) => string;
}

export interface StateMigrationInput {
  /** The migration's name: the gate its request waits at. */
  name: string;
  /** The requester. Their own approval never counts. */
  by: string;
  roots: MigrationRootPlan[];
  engine: StateMigrationEngine;
  words: StateMigrationWords;
  /** The product's facts the request binds, such as the migration file's path and digest. */
  fields?: Record<string, string>;
  /** The product's facts the finished line adds, given how it ended. */
  detail?: (result: StateMigrationResult) => Record<string, string | number | boolean>;
  rules: GatedRequestRules;
  description?: string;
  cwd?: string;
  base?: string;
  /** How long a request waits for its approval. Default 48h. */
  expiry?: string;
  now?: string;
  runId?: string;
  commit?: string;
  ledger?: GatedRequestLedger;
}

/** How the write ended, once approved. */
export interface StateMigrationResult {
  status: "applied" | "moved" | "failed";
  roots: MigrationRootPlan[];
  /** The roots whose state is not the one planned. */
  moved?: string[];
  error?: string;
}

/** How a migration ended. `exit` is the code its command exits with. */
export type StateMigrationOutcome =
  | { status: "proof-failed"; exit: 1; roots: MigrationRootPlan[]; failing: string[] }
  | { status: "waiting"; exit: 3; digest: string; command: string }
  | { status: "refused"; exit: 3; digest: string; command: string; by: string; reason: string }
  /** It applied already; a migration applies once. */
  | { status: "spent"; exit: 0; digest: string }
  | { status: "applied"; exit: 0; digest: string; approvedBy: string; result: StateMigrationResult; recorded: boolean }
  /** Under the locks a state was not the one planned: nothing was written, and the approval is spent. */
  | { status: "moved"; exit: 4; digest: string; approvedBy: string; result: StateMigrationResult; recorded: boolean }
  | { status: "failed"; exit: 1; digest: string; error: string; result?: StateMigrationResult; recorded: boolean };

const same = (a: MigrationStateAt, b: MigrationStateAt): boolean => (a.version_id ?? undefined) === (b.version_id ?? undefined) && a.digest === b.digest;

/** The finished line's flat facts: how it ended, and each root's location, versions and digests. */
export function migrationFacts(result: StateMigrationResult): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    result: result.status === "moved" ? "refused" : result.status,
    roots: result.roots.map((r) => r.root).join(","),
    ...(result.moved?.length ? { moved: result.moved.join(",") } : {}),
    ...(result.error ? { error: result.error.slice(0, 400) } : {}),
  };
  for (const r of result.roots) {
    if (r.location) out[`${r.root}.location`] = r.location;
    if (r.before.version_id) out[`${r.root}.before`] = r.before.version_id;
    if (r.after.version_id) out[`${r.root}.after`] = r.after.version_id;
    if (r.before.digest) out[`${r.root}.before_digest`] = r.before.digest;
    if (r.after.digest) out[`${r.root}.after_digest`] = r.after.digest;
  }
  return out;
}

/**
 * Write the migration under the locks: check nothing moved, write, verify.
 * The locks are released whatever happens. {@link runStateMigration} runs it
 * once its request is approved; a migration whose approval an op wave's hold
 * decided already (the wave's own gate) runs it directly.
 */
export async function writeStateMigration(engine: StateMigrationEngine, roots: MigrationRootPlan[]): Promise<StateMigrationResult> {
  const release = await engine.lock();
  try {
    const moved: string[] = [];
    for (const r of roots) if (!same(await engine.current(r.root), r.before)) moved.push(r.root);
    if (moved.length > 0) return { status: "moved", roots, moved };
    try {
      await engine.write();
    } catch (e) {
      return { status: "failed", roots, error: `the write failed: ${(e as Error).message}` };
    }
    const after: MigrationRootPlan[] = [];
    for (const r of roots) {
      const v = await engine.verify(r.root);
      after.push({
        ...r,
        ...(v.before_version_id ? { before: { ...r.before, version_id: v.before_version_id } } : {}),
        after: { ...r.after, ...(v.version_id ? { version_id: v.version_id } : {}) },
        verify: { changes: v.changes, summary: v.summary },
      });
    }
    const changed = after.filter((r) => r.verify!.changes.length > 0).map((r) => r.root);
    return changed.length > 0 ? { status: "failed", roots: after, error: `after the write, ${changed.join(", ")} plan changes` } : { status: "applied", roots: after };
  } finally {
    await release();
  }
}

/**
 * Ask for, or with an approval write, a proved migration. Refuses a plan
 * whose proof shows a change before anything is asked.
 */
export async function runStateMigration(input: StateMigrationInput): Promise<StateMigrationOutcome> {
  const failing = input.roots.filter((r) => r.proof.changes.length > 0).map((r) => r.root);
  if (failing.length > 0) return { status: "proof-failed", exit: CHANT_EXIT.failed, roots: input.roots, failing };
  const roots = [...input.roots].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  // The attachment binds each root's state before and after; the proof's wording is the engine's, not the migration.
  const attachment = `${JSON.stringify({ name: input.name, roots: roots.map((r) => ({ root: r.root, location: r.location ?? null, before: { version_id: r.before.version_id ?? null, digest: r.before.digest }, after: r.after.digest })) }, null, 2)}\n`;
  const result = await gatedOp(
    {
      op: input.words.op,
      request: { kind: input.words.kind ?? "migrate", subject: input.name, by: input.by, fields: { ...(input.fields ?? {}), roots: roots.map((r) => r.root).join(",") } },
      rules: input.rules,
      description: input.description ?? `migration ${input.name}: ${roots.map((r) => r.root).join(", ")}`,
      expiry: input.expiry ?? "48h",
      attachment,
      ...(input.base ? { base: input.base } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.now ? { now: input.now } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.commit ? { commit: input.commit } : {}),
      ...(input.ledger ? { ledger: input.ledger } : {}),
    },
    async ({ approvedBy }) => {
      const written = await writeStateMigration(input.engine, roots);
      return { output: written, detail: { by: input.by, approved_by: approvedBy, ...migrationFacts(written), ...(input.detail?.(written) ?? {}) }, failed: written.status !== "applied" };
    },
  );
  const command = (fallback: string): string => (input.words.approveCommand ? input.words.approveCommand(input.name, result.digest) : fallback);
  switch (result.status) {
    case "waiting":
      return { status: "waiting", exit: CHANT_EXIT.waiting, digest: result.digest, command: command(result.command) };
    case "refused":
      return { status: "refused", exit: CHANT_EXIT.waiting, digest: result.digest, command: command(result.command), by: result.by, reason: result.reason };
    case "spent":
      return { status: "spent", exit: CHANT_EXIT.done, digest: result.digest };
    case "held":
      return { status: "failed", exit: CHANT_EXIT.failed, digest: result.digest, error: result.reason, recorded: false };
    case "failed":
      return { status: "failed", exit: CHANT_EXIT.failed, digest: result.digest, error: result.error.message, recorded: result.recorded };
    case "done": {
      const r = result.output;
      if (r.status === "applied") return { status: "applied", exit: CHANT_EXIT.done, digest: result.digest, approvedBy: result.approvedBy, result: r, recorded: result.recorded };
      if (r.status === "moved") return { status: "moved", exit: CHANT_EXIT.moved, digest: result.digest, approvedBy: result.approvedBy, result: r, recorded: result.recorded };
      return { status: "failed", exit: CHANT_EXIT.failed, digest: result.digest, error: r.error ?? "the migration failed", result: r, recorded: result.recorded };
    }
  }
}
