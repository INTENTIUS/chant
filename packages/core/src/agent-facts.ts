/**
 * The facts that start an agent job from outside a pull request (#5329).
 *
 * A production alert reaches `chant notify relay`, which checks it and
 * writes one fact per alert under `_alerts/` on `chant/lifecycle`, signed
 * with the relay key (`CHANT_RELAY_KEY`). The relay then starts the agent's
 * workflow with no inputs, and the scheduled run of the same workflow picks
 * up any fact a start missed. The agent job reads the facts itself, checks
 * each signature with the same key, and starts one run for the oldest group
 * of new facts. Nothing a caller passes to the workflow is read.
 *
 * The file is `_alerts/<trigger>.jsonl` at the repository's ledger root, one
 * fact per line. A fact is trigger-neutral: `trigger` names what wrote it.
 * A failed apply (#5357) writes `_alerts/apply-failed.jsonl` with the same
 * key, and the same reading and joining apply. A scheduled run's fact is
 * the run itself and is not written here (`./ci-agent-triggers.ts`).
 *
 * - A fact is recorded once. A second delivery with the same `key` (the
 *   source's own id) or the same `idempotencyKey` (the delivery's
 *   `Idempotency-Key` header) is a duplicate and is not appended.
 * - Facts for the same member close together join one run: the run takes
 *   every new fact for its member received within the join window of the
 *   first, and a fact for that member received later inside the same window
 *   joins the run already made instead of starting another.
 * - A run record carries the ids of the facts it took (`outcomes.agent.facts`)
 *   and its window, so the next read knows which facts are spent.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readBlobBySha, readBlobFromPath, readPathSha, RefCASConflictError, writeBlobToPath, type LedgerLocation } from "./lifecycle/git";
import type { OpRunRecord } from "./op/runtime";
import { sortedJsonReplacer } from "./sorted-json";

/** The directory on `chant/lifecycle` the facts are kept under. */
export const AGENT_FACTS_DIR = "_alerts";

/** How long after a member's first fact a later one joins the same run, in minutes, unless the agent's `window` names another. */
export const AGENT_JOIN_WINDOW_MINUTES = 15;

/** How old a fact may be when the agent job reads it: older ones start nothing. */
export const AGENT_FACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The facts are read and written at the repository's ledger root, whichever member's directory the job stands in. */
const ROOT: LedgerLocation = { ledgerPrefix: "" };

/** One fact that can start an agent run. */
export interface AgentFact {
  v: 1;
  /** `sha256:` of `trigger` and `key`. */
  id: string;
  /** What wrote it: `alert` or `apply-failed`; `schedule` for the fact a scheduled run makes of itself. */
  trigger: string;
  /** The workspace member it is for; "" for the repository. */
  member: string;
  /** The source's own id for what happened, such as `pagerduty:Q1ABC`. A second fact with the same key is a duplicate. */
  key: string;
  /** The delivery's `Idempotency-Key` header, when it had one. */
  idempotencyKey?: string;
  /** When the source says it happened. */
  at: string;
  /** When the fact was recorded. */
  received: string;
  /** The principal that recorded it, such as `<product>-relay`. */
  by: string;
  /** The trigger's own record, as data. */
  data: Record<string, unknown>;
  /** HMAC-SHA256 of the rest, hex, with the relay key. */
  sig: string;
}

export type UnsignedAgentFact = Omit<AgentFact, "v" | "id" | "sig">;

const factId = (trigger: string, key: string): string => `sha256:${createHash("sha256").update(`${trigger}\n${key}`).digest("hex")}`;

const factMac = (key: string, fact: Omit<AgentFact, "sig">): string => createHmac("sha256", key).update(`chant-agent-fact.${JSON.stringify(fact, sortedJsonReplacer)}`, "utf8").digest("hex");

/** The fact, its id minted and signed with the relay key. */
export function signAgentFact(relayKey: string, f: UnsignedAgentFact): AgentFact {
  if (!relayKey) throw new Error("an agent fact is signed with the relay key, and none was given");
  const unsigned: Omit<AgentFact, "sig"> = { v: 1, id: factId(f.trigger, f.key), ...f };
  return { ...unsigned, sig: factMac(relayKey, unsigned) };
}

/** Whether the relay key signed `fact`, and its id is the one its trigger and key give. */
export function verifyAgentFact(relayKey: string | undefined, fact: AgentFact): boolean {
  if (!relayKey || typeof fact.sig !== "string" || !/^[0-9a-f]{64}$/.test(fact.sig)) return false;
  if (fact.id !== factId(fact.trigger, fact.key)) return false;
  const { sig, ...rest } = fact;
  const want = Buffer.from(factMac(relayKey, rest));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** The file a trigger's facts are kept in under {@link AGENT_FACTS_DIR}. */
export function agentFactFile(trigger: string): string {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(trigger)) throw new Error(`${JSON.stringify(trigger)} is not a trigger name`);
  return `${trigger}.jsonl`;
}

const isString = (v: unknown): v is string => typeof v === "string";

/** The facts in one file's text, oldest first. A line that is not a fact is skipped and counted. */
export function parseAgentFacts(content: string): { facts: AgentFact[]; malformed: number } {
  const facts: AgentFact[] = [];
  let malformed = 0;
  for (const line of content.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const f = JSON.parse(line) as Partial<AgentFact>;
      if (f.v !== 1 || ![f.id, f.trigger, f.member, f.key, f.at, f.received, f.by, f.sig].every(isString) || typeof f.data !== "object" || f.data === null || (f.idempotencyKey !== undefined && !isString(f.idempotencyKey))) {
        malformed++;
        continue;
      }
      facts.push(f as AgentFact);
    } catch {
      malformed++;
    }
  }
  return { facts, malformed };
}

/** A trigger's facts on the ledger, oldest first. */
export async function readAgentFacts(trigger: string, opts: { cwd?: string } = {}): Promise<AgentFact[]> {
  const content = await readBlobFromPath(AGENT_FACTS_DIR, agentFactFile(trigger), { ...ROOT, ...opts });
  return content ? parseAgentFacts(content).facts : [];
}

/** Whether `f` is the same delivery as one of `seen`: the same key, or the same idempotency key. */
export function duplicateOf(f: Pick<AgentFact, "key" | "idempotencyKey">, seen: readonly Pick<AgentFact, "key" | "idempotencyKey">[]): boolean {
  return seen.some((s) => s.key === f.key || (f.idempotencyKey !== undefined && s.idempotencyKey === f.idempotencyKey));
}

/**
 * Append the facts that are not duplicates to their trigger's file, in one
 * commit, with the ledger's compare-and-swap retry. Does not push: the
 * caller pushes `chant/lifecycle` after, as every ledger here does.
 */
export async function recordAgentFacts(facts: readonly AgentFact[], opts: { cwd?: string } = {}): Promise<{ recorded: AgentFact[]; duplicates: AgentFact[] }> {
  const triggers = [...new Set(facts.map((f) => f.trigger))];
  if (triggers.length > 1) throw new Error("one call records the facts of one trigger");
  if (facts.length === 0) return { recorded: [], duplicates: [] };
  const file = agentFactFile(triggers[0]!);
  const where = { ...ROOT, ...opts };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const priorSha = await readPathSha(AGENT_FACTS_DIR, file, where);
    const existing = priorSha ? ((await readBlobBySha(priorSha, opts)) ?? "") : "";
    const seen: Pick<AgentFact, "key" | "idempotencyKey">[] = parseAgentFacts(existing).facts;
    const recorded: AgentFact[] = [];
    const duplicates: AgentFact[] = [];
    for (const f of facts) {
      if (duplicateOf(f, seen)) duplicates.push(f);
      else {
        recorded.push(f);
        seen.push(f);
      }
    }
    if (recorded.length === 0) return { recorded, duplicates };
    const lines = recorded.map((f) => JSON.stringify(f, sortedJsonReplacer)).join("\n");
    const content = `${existing ? `${existing.replace(/\n$/, "")}\n` : ""}${lines}\n`;
    try {
      await writeBlobToPath(AGENT_FACTS_DIR, file, content, `Agent facts: ${recorded.length} ${triggers[0]}`, { ...where, expectPriorPathSha: priorSha });
      return { recorded, duplicates };
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

// ── reading new facts ──────────────────────────────────────────────────────

/** What a run record keeps of the facts it took, under `outcomes.agent`. */
export interface AgentFactRun {
  facts?: string[];
  member?: string;
  /** The join window the run opened: facts for `member` received inside it are the run's. */
  window?: { from: string; until: string };
}

/** The facts one run takes: one member's, the first and those received within the window after it. */
export interface AgentFactGroup {
  member: string;
  facts: AgentFact[];
  window: { from: string; until: string };
}

/** What a run record says about facts, read defensively. */
export function factRunOf(record: Pick<OpRunRecord, "outcomes">): AgentFactRun {
  const a = record.outcomes?.agent as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return {};
  const facts = Array.isArray(a.facts) ? a.facts.filter(isString) : undefined;
  const w = a.window as { from?: unknown; until?: unknown } | undefined;
  return {
    ...(facts ? { facts } : {}),
    ...(isString(a.member) ? { member: a.member } : {}),
    ...(w && isString(w.from) && isString(w.until) ? { window: { from: w.from, until: w.until } } : {}),
  };
}

/**
 * The new facts, grouped into runs, oldest group first, and the facts set
 * aside with why. A fact is set aside when the relay key did not sign it,
 * when it is older than `maxAgeMs`, or when a run took it already or its
 * member's window was open when it arrived (it joined that run).
 */
export function pendingAgentFacts(o: {
  facts: readonly AgentFact[];
  runs: readonly Pick<OpRunRecord, "outcomes">[];
  relayKey: string | undefined;
  /** How a fact is checked, in place of the relay key's signature: a schedule's fact is the run's own (#5357). */
  verify?: (f: AgentFact) => boolean;
  now: Date;
  windowMs: number;
  maxAgeMs?: number;
}): { groups: AgentFactGroup[]; setAside: Array<{ id: string; reason: "unsigned" | "stale" | "taken" | "joined" }> } {
  const setAside: Array<{ id: string; reason: "unsigned" | "stale" | "taken" | "joined" }> = [];
  const runs = o.runs.map(factRunOf);
  const taken = new Set(runs.flatMap((r) => r.facts ?? []));
  const windows = runs.filter((r) => r.window && r.member !== undefined).map((r) => ({ member: r.member!, from: Date.parse(r.window!.from), until: Date.parse(r.window!.until) }));
  const maxAge = o.maxAgeMs ?? AGENT_FACT_MAX_AGE_MS;
  const now = o.now.getTime();
  const fresh: AgentFact[] = [];
  const seen: AgentFact[] = [];
  for (const f of o.facts) {
    if (!(o.verify ? o.verify(f) : verifyAgentFact(o.relayKey, f))) {
      setAside.push({ id: f.id, reason: "unsigned" });
      continue;
    }
    // A duplicate line that reached the file anyway is the same fact.
    if (duplicateOf(f, seen)) continue;
    seen.push(f);
    const received = Date.parse(f.received);
    if (taken.has(f.id)) setAside.push({ id: f.id, reason: "taken" });
    else if (!Number.isFinite(received) || now - received > maxAge) setAside.push({ id: f.id, reason: "stale" });
    else if (windows.some((w) => w.member === f.member && received >= w.from && received <= w.until)) setAside.push({ id: f.id, reason: "joined" });
    else fresh.push(f);
  }
  fresh.sort((a, b) => Date.parse(a.received) - Date.parse(b.received));
  const groups: AgentFactGroup[] = [];
  for (const f of fresh) {
    const t = Date.parse(f.received);
    const open = groups.find((g) => g.member === f.member && t <= Date.parse(g.window.until));
    if (open) open.facts.push(f);
    else groups.push({ member: f.member, facts: [f], window: { from: f.received, until: new Date(t + o.windowMs).toISOString() } });
  }
  return { groups, setAside };
}
