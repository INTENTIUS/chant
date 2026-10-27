/**
 * The lock grain (#4552) and the rows a plan locks: the pure half of
 * ./resource-lock.ts, with no git and no process access, so the pull-request
 * report, the change-set bundles and the lexicons can import it.
 *
 * `ci.lockGrain` (ruling A) says what one apply holds while it applies, and,
 * under `ci.locks`, what a pull request's target locks name (ruling D):
 *
 * - `target`: the component, member, root or stack. The apply takes no row
 *   lease; the engine's own lock keeps one target's applies apart.
 * - `resource`: one row per resource the plan changes, from the lexicon's
 *   `lockRows` hook. The apply leases those rows before it applies and lets
 *   go after, and a pull request under `ci.locks` locks the same keys in
 *   place of its component names.
 * - `repo`: one apply at a time in the repository, which the pipeline keeps
 *   (a concurrency group, a resource group, the lock tag on Forgejo).
 *
 * Absent, each member takes its lexicon's `defaultLockGrain`, else `target`.
 *
 * Row keys are strings the lexicons write, compared exactly, with one rule
 * of cover (ruling C): a `stack <project>/<stack>` row conflicts with every
 * `urn urn:pulumi:<stack>::<project>::...` row of that stack, which is how a
 * plunge apply whose components may register children only at apply locks
 * the whole stack and still meets a run holding one of its resources.
 */
import { parsePulumiUrn } from "../pulumi-urn";

/** The values of `ci.lockGrain`. */
export const LOCK_GRAINS = ["target", "resource", "repo"] as const;
export type LockGrain = (typeof LOCK_GRAINS)[number];

/** Whether `value` is a lock grain. */
export function isLockGrain(value: unknown): value is LockGrain {
  return typeof value === "string" && (LOCK_GRAINS as readonly string[]).includes(value);
}

/** One row an apply holds: its key, the target (root, stack, member) it belongs to, and the address the change is at. */
export interface LockRow {
  key: string;
  target: string;
  address: string;
}

/** A member's grain as planned, and, on the resource grain, the rows its plan locks. */
export interface PlannedLock {
  grain: LockGrain;
  /** Where the grain came from: the step's own `lockGrain`, the declaration (`ci.lockGrain`), the lexicon's default, or chant's (`target`). */
  source: "step" | "declared" | "lexicon" | "default";
  /** The rows, sorted by key. Empty on any grain but `resource`. */
  rows: LockRow[];
}

/** A lexicon refused the grain asked of a member, by name (#4552: `resource` on Terraform, tofu, Terragrunt and stock Pulumi). */
export class LockGrainRefusedError extends Error {
  constructor(
    public readonly member: string,
    public readonly grain: LockGrain,
    reason: string,
  ) {
    super(`"${member}": the ${grain} lock grain is refused: ${reason}`);
    this.name = "LockGrainRefusedError";
  }
}

/** The key of the row that stands for a whole Pulumi stack (ruling C). */
export function stackRowKey(project: string, stack: string): string {
  return `stack ${project}/${stack}`;
}

/** The key of a URN's row. */
export function urnRowKey(urn: string): string {
  return `urn ${urn}`;
}

/** The key of a live object's row: two members that act on one object meet here. */
export function objectRowKey(id: string): string {
  return `object ${id}`;
}

/** The row that covers `key`, when one does: a URN row's stack row. Undefined for every other key. */
export function lockRowCover(key: string): string | undefined {
  if (!key.startsWith("urn ")) return undefined;
  const parsed = parsePulumiUrn(key.slice(4));
  return parsed ? stackRowKey(parsed.project, parsed.stack) : undefined;
}

/** Whether a holder of row `a` keeps row `b` from being taken: the same key, or one covers the other. */
export function lockRowsConflict(a: string, b: string): boolean {
  return a === b || lockRowCover(a) === b || lockRowCover(b) === a;
}

/** Rows deduplicated by key and sorted, so two takes of the same rows write the same file. */
export function sortedLockRows(rows: readonly LockRow[]): LockRow[] {
  const byKey = new Map<string, LockRow>();
  for (const r of rows) if (!byKey.has(r.key)) byKey.set(r.key, r);
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** What a capability offers for its grain: the three hooks of `Capability` (../components/capability.ts). */
export interface LockGrainHooks {
  kind: string;
  defaultLockGrain?(input: never, plan?: never): LockGrain | Promise<LockGrain>;
  lockGrainRefusal?(input: never, grain: LockGrain, plan?: never): string | undefined | Promise<string | undefined>;
  lockRows?(input: never, plan: never): LockRow[] | Promise<LockRow[]>;
}

/**
 * A member's grain and rows (#4552): the step input's own `lockGrain` when it
 * has one (`pulumi-up` takes it), else the declared grain, else the lexicon's
 * default, else `target`. A grain the lexicon refuses throws
 * {@link LockGrainRefusedError}, and so does `resource` on a capability with
 * no `lockRows` hook, since nothing would say what to hold.
 */
export async function resolvePlannedLock(capability: LockGrainHooks, input: unknown, plan: { member: string }, declared: LockGrain | null | undefined): Promise<PlannedLock> {
  const own = (input as { lockGrain?: unknown } | null | undefined)?.lockGrain;
  const step = isLockGrain(own) ? own : undefined;
  const source: PlannedLock["source"] = step ? "step" : declared ? "declared" : capability.defaultLockGrain ? "lexicon" : "default";
  const grain: LockGrain = step ?? declared ?? (capability.defaultLockGrain ? await capability.defaultLockGrain(input as never, plan as never) : "target");
  const refused = capability.lockGrainRefusal ? await capability.lockGrainRefusal(input as never, grain, plan as never) : undefined;
  if (refused) throw new LockGrainRefusedError(plan.member, grain, refused);
  if (grain !== "resource") return { grain, source, rows: [] };
  if (!capability.lockRows) throw new LockGrainRefusedError(plan.member, grain, `${capability.kind} names no rows for its resources; set ci.lockGrain to target`);
  return { grain, source, rows: sortedLockRows(await capability.lockRows(input as never, plan as never)) };
}

/**
 * The names a pull request's target locks take under `ci.locks` (ruling D):
 * the row keys of each member on the resource grain, and the component's own
 * name for every component with a member on another grain (or with no
 * planned lock). `locks` is by member, each with its component.
 */
export function lockTargetsOf(order: readonly string[], locks: Readonly<Record<string, PlannedLock & { component: string }>> | undefined): string[] {
  if (!locks || Object.keys(locks).length === 0) return [...order];
  const out = new Set<string>();
  const byComponent = new Map<string, Array<PlannedLock & { component: string }>>();
  for (const l of Object.values(locks)) byComponent.set(l.component, [...(byComponent.get(l.component) ?? []), l]);
  for (const component of order) {
    const mine = byComponent.get(component) ?? [];
    if (mine.length === 0 || mine.some((l) => l.grain !== "resource")) out.add(component);
    for (const l of mine) if (l.grain === "resource") for (const r of l.rows) out.add(r.key);
  }
  return [...out].sort();
}

/** Whether any member is on the resource grain, so its pull request locks rows rather than component names. */
export function anyResourceGrain(locks: Readonly<Record<string, PlannedLock>> | undefined): boolean {
  return Object.values(locks ?? {}).some((l) => l.grain === "resource");
}

/** Every row the resource-grain members of `locks` hold, deduplicated and sorted: what one apply leases. */
export function leaseRowsOf(locks: Readonly<Record<string, PlannedLock>> | undefined): LockRow[] {
  return sortedLockRows(Object.values(locks ?? {}).flatMap((l) => (l.grain === "resource" ? l.rows : [])));
}
