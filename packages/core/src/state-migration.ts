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
 *
 * A root whose new state is read from somewhere else (a backend move, #4806)
 * names that place as its `source`: the request binds it, and under the
 * locks the engine reads it again, so a source that moved refuses the write
 * as a root's own state does. A request that waits while an approval of an
 * earlier request of the same migration stands, made since that request was
 * asked, answers `approval-moved` and names the roots whose state moved
 * between the two (#4806).
 *
 * A product's own record of the migration (its moves, retags and stamps)
 * goes in the attachment beside the roots as `record` (#4928): canonical
 * JSON, at most {@link STATE_MIGRATION_RECORD_MAX_BYTES}, so the digest binds
 * it and `chant approve` shows it with the roots.
 */
import { canonicalJson } from "./effect-receipt";
import { CHANT_EXIT } from "./exit-codes";
import { chantGatedLedger, gatedOp, type GatedRequestLedger } from "./lifecycle/gated-op";
import type { GatedRequestRules } from "./lifecycle/gated-request";
import { gatedRequestAttachmentPath } from "./lifecycle/gated-request-digest";
import { samePlanDigest } from "./lifecycle/plan-digest";
import { NEXT_RELEASE } from "./release-floors";

/** The first chant with the engine-neutral state migration (#4762). */
export const STATE_MIGRATION_FLOOR = "0.124.77";

/** The first chant whose migration binds a root's `source` (an engine's `source` read under the locks) and answers `approval-moved`, and whose terraform lexicon plans backend moves (`planTerraformMigration`'s `backends`) and choudoufu estate migrations (`planEstateMigration`) onto it (#4806). */
export const STATE_MIGRATION_SOURCE_FLOOR = "0.124.86";

/** The first chant whose `runStateMigration` takes a product's `record`, which the request's attachment binds beside the roots and `chant approve` shows (#4928). */
export const STATE_MIGRATION_RECORD_FLOOR = NEXT_RELEASE;

/** The most a product's migration `record` may take, as canonical JSON in UTF-8 (#4928): a record names moves, retags and stamps, never a state's contents. */
export const STATE_MIGRATION_RECORD_MAX_BYTES = 64 * 1024;

/** A product's migration `record` that cannot be bound: not JSON, or over {@link STATE_MIGRATION_RECORD_MAX_BYTES}. Thrown before anything is asked. */
export class StateMigrationRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateMigrationRecordError";
  }
}

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
  /** Where the new state is read from, when that is not the root's own state (a backend move, #4806): the request binds it, and the write is refused when it moved. */
  source?: MigrationSource;
}

/** A state a migration reads its new state from: where it is, its version id when its store keeps versions, and its digest. */
export interface MigrationSource {
  location?: string;
  version_id?: string;
  digest: string;
}

/** The engine's half of a migration's write. */
export interface StateMigrationEngine {
  /** Take the lock of every state the migration writes or reads. Throws when one is held, having released what it took. Answers the release. */
  lock(): Promise<() => Promise<void>>;
  /** A root's state now, read under the locks. */
  current(root: string): Promise<MigrationStateAt>;
  /** A root's source now, read under the locks; called for each root whose plan names a `source` (#4806). */
  source?(root: string): Promise<MigrationStateAt>;
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
  /**
   * The product's own record of the migration, such as its moves, retags and
   * stamps (#4928). It goes in the request's attachment beside the roots as
   * canonical JSON (keys sorted), so the request's digest binds it and
   * `chant approve` shows it. At most {@link STATE_MIGRATION_RECORD_MAX_BYTES};
   * a record that is larger or is not JSON throws {@link StateMigrationRecordError}
   * before anything is asked. Never a state's contents. Unset, the attachment
   * is the roots alone, as before.
   */
  record?: unknown;
  /** The product's facts the finished line adds, given how it ended. */
  detail?: (result: StateMigrationResult) => Record<string, string | number | boolean>;
  rules: GatedRequestRules;
  description?: string;
  cwd?: string;
  base?: string;
  /** How long a request waits for its approval. Default 48h. */
  expiry?: string;
  /** Reads an earlier request's attachment by its digest, to name the roots that moved since its approval. Default: the attachment on chant/lifecycle. */
  readAttachment?: (op: string, digest: string) => Promise<string | undefined>;
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
  /** It waits, and an approval of an earlier request of this migration stands: the states moved since, and `moved` names the roots whose state is not the one that request bound. Nothing was written. */
  | { status: "approval-moved"; exit: 4; digest: string; command: string; approved: string; approvedBy: string; moved: string[] }
  | { status: "refused"; exit: 3; digest: string; command: string; by: string; reason: string }
  /** It applied already; a migration applies once. */
  | { status: "spent"; exit: 0; digest: string }
  | { status: "applied"; exit: 0; digest: string; approvedBy: string; result: StateMigrationResult; recorded: boolean }
  /** Under the locks a state was not the one planned: nothing was written, and the approval is spent. */
  | { status: "moved"; exit: 4; digest: string; approvedBy: string; result: StateMigrationResult; recorded: boolean }
  | { status: "failed"; exit: 1; digest: string; error: string; result?: StateMigrationResult; recorded: boolean };

const same = (a: MigrationStateAt, b: MigrationStateAt): boolean => (a.version_id ?? undefined) === (b.version_id ?? undefined) && a.digest === b.digest;

/** What a request's attachment binds of each root: its location and state before, its new state's digest, and its source when it has one. */
const boundRoot = (r: MigrationRootPlan) => ({
  root: r.root,
  location: r.location ?? null,
  before: { version_id: r.before.version_id ?? null, digest: r.before.digest },
  after: r.after.digest,
  ...(r.source ? { source: { location: r.source.location ?? null, version_id: r.source.version_id ?? null, digest: r.source.digest } } : {}),
});

/**
 * A product's record as the attachment binds it (#4928): its canonical JSON
 * read back, so its keys are in sorted order, once it is known to fit.
 */
export function boundRecord(record: unknown): unknown {
  let text: string;
  try {
    text = canonicalJson(record);
  } catch (e) {
    throw new StateMigrationRecordError(`the migration's record is not JSON: ${(e as Error).message}`);
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > STATE_MIGRATION_RECORD_MAX_BYTES) {
    throw new StateMigrationRecordError(`the migration's record is ${bytes} bytes as canonical JSON, over the ${STATE_MIGRATION_RECORD_MAX_BYTES} a request binds; keep the moves, retags and stamps, and leave the rest in the product's report`);
  }
  return JSON.parse(text) as unknown;
}

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
    if (r.source?.location) out[`${r.root}.source`] = r.source.location;
    if (r.source?.version_id) out[`${r.root}.source_version`] = r.source.version_id;
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
    for (const r of roots) {
      if (!same(await engine.current(r.root), r.before)) moved.push(r.root);
      else if (r.source && engine.source && !same(await engine.source(r.root), r.source)) moved.push(r.root);
    }
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
  // The attachment binds each root's state before and after, and the product's record when it gives one (#4928); the proof's wording is the engine's, not the migration.
  const record = input.record === undefined ? undefined : boundRecord(input.record);
  const attachment = `${JSON.stringify({ name: input.name, roots: roots.map(boundRoot), ...(record !== undefined ? { record } : {}) }, null, 2)}\n`;
  const now = input.now ?? new Date().toISOString();
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
      now,
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
    case "waiting": {
      const stood = await approvalMovedFrom(input, roots, result.digest, now);
      if (stood) return { status: "approval-moved", exit: CHANT_EXIT.moved, digest: result.digest, command: command(result.command), ...stood };
      return { status: "waiting", exit: CHANT_EXIT.waiting, digest: result.digest, command: command(result.command) };
    }
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

/** An earlier request's attachment on chant/lifecycle, by its digest. */
async function ledgerAttachment(op: string, digest: string, cwd?: string): Promise<string | undefined> {
  const { readBlobFromPath } = await import("./lifecycle/git");
  const { dir, file } = gatedRequestAttachmentPath(op, digest);
  return (await readBlobFromPath(dir, file, cwd ? { cwd } : undefined)) ?? undefined;
}

/**
 * The approval a waiting request moved away from (#4806): a state written
 * after an approval changes the request's digest, so the migration asks
 * again. The approval that stands is the newest of another request of the
 * migration, unspent, not its requester's own, and made since the newest
 * pending fact before this run (`now` is this run's: a pending fact of that
 * time is the one this run asked). The roots that moved are those whose
 * bound state differs from that request's attachment, or every root when
 * the attachment cannot be read. Undefined when no approval stands.
 *
 * Lifted from terragucci's `movedSinceChantApproval` and `beforeMembers`.
 */
async function approvalMovedFrom(input: StateMigrationInput, roots: MigrationRootPlan[], digest: string, now: string): Promise<{ approved: string; approvedBy: string; moved: string[] } | undefined> {
  const ledger = input.ledger ?? chantGatedLedger;
  let requests: Awaited<ReturnType<GatedRequestLedger["readGatedRequests"]>>;
  try {
    requests = await ledger.readGatedRequests(input.words.op, input.cwd ? { cwd: input.cwd } : undefined);
  } catch {
    return undefined;
  }
  const t = (s: string | undefined): number => (s ? Date.parse(s) : 0);
  const mine = requests.filter((r) => r.gate === input.name);
  const asked = (r: (typeof mine)[number]): boolean => samePlanDigest(r.digest, digest) && t(r.pending.timestamp) === t(now);
  const since = Math.max(0, ...mine.filter((r) => !asked(r)).map((r) => t(r.pending.timestamp)).filter((x) => !Number.isNaN(x)));
  let prior: (typeof mine)[number] | undefined;
  let approval: (typeof mine)[number]["approvals"][number] | undefined;
  for (const r of mine) {
    if (samePlanDigest(r.digest, digest) || r.applied) continue;
    const requester = r.request.by.toLowerCase();
    for (const a of r.approvals) {
      if (a.resolvedBy.toLowerCase() === requester || t(a.timestamp) < since) continue;
      if (!approval || t(a.timestamp) >= t(approval.timestamp)) [prior, approval] = [r, a];
    }
  }
  if (!prior || !approval) return undefined;
  let stored: { roots?: unknown } | undefined;
  try {
    const text = input.readAttachment ? await input.readAttachment(input.words.op, prior.digest) : await ledgerAttachment(input.words.op, prior.digest, input.cwd);
    stored = text ? (JSON.parse(text) as { roots?: unknown }) : undefined;
  } catch {
    stored = undefined;
  }
  const was = new Map<string, string>();
  if (Array.isArray(stored?.roots)) for (const r of stored.roots as Array<{ root?: unknown }>) if (typeof r.root === "string") was.set(r.root, JSON.stringify({ ...r, after: null }));
  const moved = Array.isArray(stored?.roots) ? roots.filter((r) => was.get(r.root) !== JSON.stringify({ ...boundRoot(r), after: null })).map((r) => r.root) : roots.map((r) => r.root);
  return { approved: prior.digest, approvedBy: approval.resolvedBy, moved };
}
