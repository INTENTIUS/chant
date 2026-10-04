/**
 * The factory's rules (#3406, ws-087): what every orchestrator of a factory
 * must agree on, as pure functions over what the read contract prints. The
 * reference Op (`./factory.ts`) runs them; an orchestrator supplies only
 * execution (the builder, the context, the check).
 *
 * - Readiness ({@link pickable}): on top of the work kind's `ready`, the box's
 *   intent is decided, a contract the item builds is approved and in force,
 *   the item is under its attempt limit, it is not done and waiting to be
 *   applied on its branch, its slice-tier and understand questions are not
 *   open, an understand answer of redraft or ask holds it, and a failed last
 *   build holds it until a person asks for a retry ({@link retryState}).
 * - The understand point's answers ({@link understandOutcome}): proceed
 *   builds; refuse drops the item on its branch; redraft and ask build
 *   nothing and leave it for its author. Each maps to a lease outcome, and
 *   only a build's outcome counts as an attempt (#3147).
 * - Done ({@link doneVerdict}): the builder finished, the check ran and
 *   passed, and every criterion the factory may tick has passing evidence. A
 *   criterion verified `manual` or `runtime` is not the factory's to tick, so
 *   an item with one is not done by the factory.
 * - Retry ({@link retryState}): a failed build is never tried again on its
 *   own. A person's request, the item's `retry: { after, by, at }`, names the
 *   lease token of the failed build it follows, so one request starts one run.
 * - Implements ({@link proposeImplements}): a build recorded done proposes
 *   each decision in force that constrains, by path, a path it changed.
 */

/** The decision point that gates every build of a person's ask (#3150). */
export const UNDERSTAND_POINT = "understand";
/** The decision point that picks a builder tier (ws-057, #3150). */
export const TIER_POINT = "slice-tier";

/** What the understand point answers. */
export const UNDERSTAND_ANSWERS = ["proceed", "redraft", "ask", "refuse"] as const;
export type UnderstandAnswer = (typeof UNDERSTAND_ANSWERS)[number];

/** Why an item is not picked. Closed. */
export const FACTORY_HOLDS = [
  "not-ready",
  "intent-undecided",
  "contract-not-approved",
  "attempts-exhausted",
  "awaiting-retry",
  "built-not-applied",
  "dropped-on-branch",
  "question-open",
  "redraft-or-ask",
  "leased",
] as const;
export type FactoryHold = (typeof FACTORY_HOLDS)[number];

/** A work item as the factory reads it: its record from `records --json`, trimmed to what the rules use. */
export interface FactoryItem {
  id: string;
  state: string | null;
  /** The kind's open state, such as open. */
  openState: string;
  /** The kind's first state for a proposal, such as proposed; an ask in it is a candidate too. */
  proposedState: string | null;
  ready: boolean;
  data: Record<string, unknown> | null;
  /** The item's own tier, or null. */
  tier: string | null;
  /** The contract it builds, with that record's state, or null. */
  contract: { id: string; state: string | null } | null;
  /** The record's warnings' codes. */
  warnings: string[];
  /** The answers about it, as records --json joins them. */
  answers: { id: string; point: string | null; state: string | null; answer: string | boolean | null }[];
  /** Someone holds its lease now. */
  leased: boolean;
}

/** One claim of the item's lease history, as `work history --json` prints it. */
export interface FactoryClaim {
  token: string;
  ended: string;
  outcome: string | null;
  attempt: boolean;
}

/** What the factory knows besides the item. */
export interface FactoryContext {
  /** null when no box names an intent; else whether that decision is decided. */
  intentDecided: boolean | null;
  claims: FactoryClaim[];
  attempts: { exhausted: boolean };
  /** The item as its work branch holds it, when the branch exists: its state there and whether the branch is in the checkout. */
  branch: { state: string | null; applied: boolean } | null;
  /** The current question of each point for the item as it is now (a dry run), or null when not asked yet. */
  questions: { tier: { state: string; answer: string | boolean | null } | null; understand: { state: string; answer: string | boolean | null } | null };
}

/** Whether a work item is a person's ask: its source names what they said, or it is the box's first build from its intent. */
export function isAsk(data: Record<string, unknown> | null): boolean {
  const source = data?.source as { ask?: unknown; intent?: unknown } | undefined;
  return !!(source && typeof source === "object" && (source.ask || source.intent));
}

/** The retry request on an item: `retry: { after, by, at }`, or null. */
export function retryRequest(data: Record<string, unknown> | null): { after: string; by: string; at: string } | null {
  const r = data?.retry as { after?: unknown; by?: unknown; at?: unknown } | undefined;
  if (!r || typeof r !== "object" || typeof r.after !== "string" || typeof r.by !== "string") return null;
  return { after: r.after, by: r.by, at: typeof r.at === "string" ? r.at : "" };
}

export type RetryState =
  /** The last claim was a failed build and a person may ask for one more. */
  | { possible: true; after: string; asked: boolean }
  | { possible: false; reason: "no-failed-build" | "attempts-exhausted" | "held"; message: string };

/**
 * Whether a person may ask for item `data`'s failed build to run again: the
 * last claim is a failed build, nobody holds the lease, and attempts remain.
 * `asked` says a request naming that build is already on the item.
 */
export function retryState(data: Record<string, unknown> | null, claims: readonly FactoryClaim[], attempts: { exhausted: boolean }, leased: boolean): RetryState {
  if (leased) return { possible: false, reason: "held", message: "someone holds the item's lease now" };
  const last = claims.at(-1);
  if (!last || !last.attempt) return { possible: false, reason: "no-failed-build", message: "the item's last claim is not a failed build, so there is nothing to retry" };
  if (attempts.exhausted) return { possible: false, reason: "attempts-exhausted", message: "the item has used every attempt its limit allows, so it is left to people" };
  const asked = retryRequest(data)?.after === last.token;
  return { possible: true, after: last.token, asked };
}

/** The lease outcome an understand answer leads to: null for proceed, which builds. */
export function understandOutcome(answer: unknown): "dropped" | "redraft" | "ask" | null {
  if (answer === "refuse") return "dropped";
  if (answer === "redraft" || answer === "ask") return answer;
  return null;
}

const OPEN = new Set(["escalated", "proposed"]);

/**
 * Whether the factory picks `item` now, or why not. Asks are candidates while
 * proposed as well as open; any other item only when the work kind reads it
 * ready.
 */
export function pickable(item: FactoryItem, ctx: FactoryContext): { ok: true } | { ok: false; hold: FactoryHold; message: string } {
  const no = (hold: FactoryHold, message: string) => ({ ok: false as const, hold, message });
  if (ctx.intentDecided === false) return no("intent-undecided", "the box's intent is not decided yet, so nothing is picked");
  if (item.leased) return no("leased", `${item.id} is leased`);
  const ask = isAsk(item.data);
  const candidate = item.ready || (ask && item.proposedState !== null && item.state === item.proposedState);
  if (!candidate) return no("not-ready", `${item.id} is ${item.state ?? "in no state"} and not ready`);
  if (item.contract && (item.warnings.includes("work-contract-undecided") || item.warnings.includes("work-contract-unknown"))) {
    return no("contract-not-approved", `${item.id} builds ${item.contract.id}, which is not approved and in force`);
  }
  if (ctx.branch && !ctx.branch.applied && ctx.branch.state === "done") return no("built-not-applied", `${item.id} is built on its branch and waits to be applied`);
  if (ctx.branch && !ctx.branch.applied && ctx.branch.state === "dropped") return no("dropped-on-branch", `${item.id} was dropped on its branch`);
  if (ctx.attempts.exhausted) return no("attempts-exhausted", `${item.id} has used every attempt, so it is left to people`);
  const last = ctx.claims.at(-1);
  if (last?.attempt && retryRequest(item.data)?.after !== last.token) {
    return no("awaiting-retry", `${item.id}'s last build failed; a person asks for another with retry.after: ${last.token}`);
  }
  for (const [name, q] of [[TIER_POINT, item.tier === null ? ctx.questions.tier : null], [UNDERSTAND_POINT, ask ? ctx.questions.understand : null]] as const) {
    if (q && OPEN.has(q.state)) return no("question-open", `${item.id}'s ${name} question is ${q.state}; a person answers it first`);
  }
  const u = ask ? ctx.questions.understand : null;
  if (u && u.state === "answered" && (u.answer === "redraft" || u.answer === "ask")) {
    return no("redraft-or-ask", `${item.id}'s understand question was answered ${String(u.answer)}; its author changes the item, which asks again`);
  }
  return { ok: true };
}

/** One acceptance criterion's state, as records --json lists it. */
export interface CriterionView {
  id: string;
  verification: string;
  met: boolean;
}

/** Whether a build is done, or why not. */
export function doneVerdict(build: { finished: boolean; reverted: string[] }, check: { ran: boolean; ok: boolean }, criteria: readonly CriterionView[]): { done: true } | { done: false; reason: string } {
  if (!build.finished) return { done: false, reason: "the builder did not finish" };
  if (build.reverted.length > 0) return { done: false, reason: `the guard put back what the builder changed out of scope: ${build.reverted.join(", ")}` };
  if (!check.ran) return { done: false, reason: "no check ran" };
  if (!check.ok) return { done: false, reason: "the check failed" };
  const people = criteria.filter((c) => c.verification === "manual" || c.verification === "runtime");
  if (people.length > 0) return { done: false, reason: `criteria ${people.map((c) => c.id).join(", ")} are verified ${people.map((c) => c.verification).join("/")}, which the factory never ticks` };
  const unmet = criteria.filter((c) => !c.met);
  if (unmet.length > 0) return { done: false, reason: `criteria ${unmet.map((c) => c.id).join(", ")} have no passing evidence` };
  return { done: true };
}

/**
 * The decisions a done build proposes it implements (studio#243): from the
 * intent graph's `constrains` edges of granularity `path` to each changed
 * path, the decisions in force, less those the item already implements.
 */
export function proposeImplements(
  changed: readonly { path: string; decisions: readonly { id: string; state: string | null; granularity: string }[] }[],
  already: readonly string[],
  inForce: readonly string[] = ["decided", "ratified"],
): { decision: string; paths: string[] }[] {
  const out = new Map<string, string[]>();
  for (const c of changed) {
    for (const d of c.decisions) {
      if (d.granularity !== "path" || d.state === null || !inForce.includes(d.state) || already.includes(d.id)) continue;
      const paths = out.get(d.id) ?? [];
      if (!paths.includes(c.path)) paths.push(c.path);
      out.set(d.id, paths);
    }
  }
  return [...out].map(([decision, paths]) => ({ decision, paths }));
}

/**
 * The key of the state an item was read in, for a steward's ready step: a
 * new key is work no run was started for. It names the item, its last claim
 * and its open questions, so a person's answer to either point is a new key.
 */
export function readyKey(item: Pick<FactoryItem, "id">, ctx: Pick<FactoryContext, "claims" | "questions">, data: Record<string, unknown> | null): string {
  const last = ctx.claims.at(-1)?.token ?? "none";
  const q = (x: { state: string; answer: unknown } | null) => (x ? `${x.state}:${String(x.answer)}` : "-");
  return `${item.id}@${last}#tier=${q(ctx.questions.tier)}#understand=${q(ctx.questions.understand)}#retry=${retryRequest(data)?.after ?? "-"}`;
}
