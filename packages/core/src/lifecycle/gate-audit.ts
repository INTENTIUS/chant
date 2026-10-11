/**
 * An audit trail from the gate ledger (#3764, decision #3756). Pure: ledger
 * lines (and, if the product has them, the applies that ran under a gate) go
 * in; typed entries and the gaps they show come out. It reads no git, no
 * clock and no file, so it bundles into a product's single CI file
 * (`gate-audit-bundle.test.ts` holds the import graph).
 *
 * Both products derived this themselves: terragucci's `report/audit.ts` and
 * SQL Yodeler's `report/audit.ts` each parse `_gates/<op>.jsonl`. Storage
 * (an append-only record, a bucket, a history table) and rendering stay with
 * them.
 *
 * ## Entries
 *
 * | kind                 | source line                                                      |
 * |----------------------|------------------------------------------------------------------|
 * | `approval-requested` | a pending fact of a gate that is not an override                 |
 * | `approved`           | a resolution of such a gate (seal, approver, review, relay)      |
 * | `override-requested` | a pending fact of an override gate: a denial that waits          |
 * | `override-recorded`  | a resolution of an override gate (reason in `note`)              |
 * | `revoked`            | a resolution a commit removed from the file (`subject` says which) |
 * | `applied`            | an apply the caller passes in, with the approval it ran under    |
 * | `override-spent`     | an override an apply the caller passes in cites                  |
 *
 * An override gate is, by default, any gate of the op `policy-override`
 * (terragucci writes one gate per root) or named `override-<rule>` (SQL
 * Yodeler's `yodel override`). chant's override gate (#3760,
 * `../override-gate.ts`) records under the op `policy-override`, so the
 * default reads it, and its `overrideAuditApplies` turns applied records into
 * applies that cite the override they spent. {@link GateAuditOptions.isOverride}
 * replaces the rule. Anything a line carries beyond the typed fields is kept in
 * `detail`, and `kind` is checked against {@link GATE_AUDIT_KINDS} only by
 * the type, never by the reader.
 *
 * ## Gaps
 *
 * - `approval-without-request`: a resolution with no pending fact of its gate
 *   before it (or none for its digest). Overrides are exempt: both products
 *   may record one without a denial on file.
 * - `unsealed`: an approval or override with neither a seal nor a pull
 *   request review, where {@link GateAuditOptions.sealed} says the gate needs
 *   one.
 * - `approval`: an apply with a digest that no approval of its gate holds
 *   for that digest, recorded at or before the apply. Needs `approval:
 *   "not-required"` to be waived, as a baseline or a policy that asked for
 *   no approval does.
 * - `override`: an apply cites an override that no line holds.
 * - `malformed-line`: a line that is not a gate record. Its content is lost
 *   to the trail, so it is said.
 *
 * ## Sources and ids
 *
 * Every ledger entry's `source` names the line it came from: `path`, `line`
 * (the line's own `line` when given, which {@link gateLedgerLines} fills
 * with the file's line number, else its 1-based place in `ledger.lines`),
 * and `text`, exactly as passed in, when the line was given as text. When the
 * line came from {@link gateLedgerLinesFromLog}, `source.author` is the
 * author of the commit that added it (or, for a revocation, removed it), and
 * resolutions also carry it as `committedBy`. Under `approval: ledger` that
 * is the only check on who pushed an approval: anyone who can push may write
 * any `resolvedBy`.
 *
 * The default `id` is a digest over the source and the record. A product
 * that already holds ids of its own (an append-only record whose ids
 * customers keep) passes {@link GateAuditOptions.id}, which gets each entry
 * with its default id and returns the id to use. `under` links follow it.
 *
 * ## Seal and review
 *
 * `seal` names how the approval came to be: `review` when the line came
 * through a forge review (`via: "pr-review"`, or a `review` field), else
 * `sealed` when it carries an ssh seal, else `unsigned`. A pull request
 * approval that `chant approve` also sealed is still `review`: the review is
 * what authorised it, and the seal attests who wrote the line. That fact is
 * kept apart as `sealed: true` with its `signer`, on any entry whose line
 * holds a seal. terragucci classifies the same way.
 */
import { canonicalJson } from "../effect-receipt";
import { contentDigest } from "../content-digest";
import { samePlanDigest } from "./plan-digest";
import type { GateLedgerPort } from "../op/gate";

export const GATE_AUDIT_KINDS = [
  "approval-requested",
  "approved",
  "override-requested",
  "override-recorded",
  "revoked",
  "applied",
  "override-spent",
] as const;
export type GateAuditKind = (typeof GATE_AUDIT_KINDS)[number];

/** How an approval was authorised: a forge review, an ssh seal, or neither. A review wins; a review that is also sealed has `sealed: true` beside it. */
export type GateAuditSeal = "sealed" | "review" | "unsigned";

/** A commit that added or removed a ledger line: its date and its author's name and email. */
export interface GateLedgerCommit {
  at: string;
  by?: string;
  email?: string;
}

/**
 * One line of a ledger file. Give the `text` as it is on disk, or the parsed
 * `record` a {@link GateLedgerPort} returns. `line` is its line number in the
 * file, when known. A line read from history carries the commit that `added`
 * it, or, if a commit removed it, `removed`, each with when and by whom.
 */
export interface GateLedgerLine {
  text?: string;
  record?: unknown;
  line?: number;
  commit?: string;
  added?: GateLedgerCommit;
  removed?: GateLedgerCommit;
}

/** One op's ledger file. */
export interface GateAuditLedger {
  op: string;
  /** For the entries' source, such as `_gates/<op>.jsonl`. Default that. */
  path?: string;
  /** Oldest first. */
  lines: readonly GateLedgerLine[];
}

/** An apply, from the product's own records (a wave report, a history row). */
export interface GateAuditApply {
  /** Where it was recorded: a report path, a history row. Goes into the id, so the same source gives the same id. */
  ref: string;
  at: string;
  /** The gate it ran under. */
  gate: string;
  /** Narrows the approval to one ledger. Default any. */
  op?: string;
  /** The plan digest it applied. Without one (a baseline) no approval is looked for. */
  digest?: string;
  by?: string;
  /** `not-required` when a policy at base let it through with no approval. Default `required`. */
  approval?: "required" | "not-required";
  /** Overrides it was let through by. */
  overrides?: ReadonlyArray<{ gate: string; digest?: string }>;
  detail?: Record<string, unknown>;
}

export interface GateAuditSource {
  /** The ledger file, or the apply's `ref` for an apply. */
  path: string;
  op?: string;
  /** Ledger entries: the line's `line`, else its 1-based place in the ledger's `lines`. */
  line?: number;
  /** Ledger entries: the line's text exactly as passed in, when it was passed as text. */
  text?: string;
  commit?: string;
  /** The commit that added the line, or for a revocation removed it, when the line came from history. */
  author?: GateLedgerCommit;
  change: "added" | "removed" | "apply";
}

export interface GateAuditEntry {
  /** `sha256:` over where the entry came from: the same sources give the same id. */
  id: string;
  kind: GateAuditKind;
  /** When it happened: the line's timestamp, the removing commit's date, or the apply's. */
  at: string;
  gate: string;
  op?: string;
  /** The plan digest the line binds. */
  digest?: string;
  /** Who: the approver or overrider, whoever removed the line, or for an apply, whoever ran it. */
  by?: string;
  /** Resolutions and revocations: reviewed, sealed, or unsigned. */
  seal?: GateAuditSeal;
  /** The line holds an ssh seal, whatever `seal` says (a sealed review is `seal: "review"`). */
  sealed?: true;
  /** The ssh signer, when sealed. */
  signer?: string;
  /** Resolutions read from history: the author of the commit that added the line, who may not be `by`. */
  committedBy?: string;
  /** Who carried the approval to chant (`chant approve --relayed-by`). */
  relayedBy?: string;
  /** A person or an agent, and the roles claimed. */
  approver?: { kind: string; roles?: string[] };
  /** The free text: an override's reason, an approval's note. */
  note?: string;
  url?: string;
  /** The forge review an approval came from. */
  review?: { pr?: number; head?: string; approvers?: string[] };
  /** Pending facts: the run that reached the gate, when it expires, what it describes. */
  runId?: string;
  expiresAt?: string;
  description?: string;
  /** Overrides: the rules the denial named (from the denial line when there is one). */
  rules?: string[];
  /** A revoked entry: what was revoked. */
  subject?: "approval" | "override";
  /** An applied entry: the approval entry it ran under, if one is held. An override-spent entry: the override entry. */
  under?: string;
  /** Everything else the line carries, such as `members`, `via` or a product's own fields. */
  detail: Record<string, unknown>;
  source: GateAuditSource;
}

export interface GateAuditGap {
  kind: "approval-without-request" | "unsealed" | "approval" | "override" | "malformed-line";
  op?: string;
  gate?: string;
  digest?: string;
  detail: string;
}

export interface GateAuditOptions {
  /** Whether a gate is an override gate. Default: op `policy-override`, or a gate named `override-...`. */
  isOverride?: (op: string, gate: string) => boolean;
  /** Whether approvals of a gate need a seal or a review. Default none. */
  sealed?: (op: string, gate: string) => boolean;
  /**
   * The id to give an entry, from the entry with its default id. Default
   * that id. A product with ids of its own keys by `entry.source` (its
   * `path`, `line`, `text`). `under` refers to the ids this returns.
   */
  id?: (entry: GateAuditEntry) => string;
}

export interface GateAuditInput extends GateAuditOptions {
  ledgers: readonly GateAuditLedger[];
  applies?: readonly GateAuditApply[];
}

export const POLICY_OVERRIDE_OP = "policy-override";

/** The default {@link GateAuditOptions.isOverride}. */
export function isOverrideGate(op: string, gate: string): boolean {
  return op === POLICY_OVERRIDE_OP || gate.startsWith("override-");
}

type Row = Record<string, unknown>;

const KNOWN = new Set([
  "version", "kind", "op", "gate", "resolvedBy", "relayedBy", "timestamp", "note", "url", "planDigest", "environment",
  "approver", "seal", "review", "runId", "expiresAt", "description", "rules", "pr", "head", "reviewers",
]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
const time = (iso: string): number => Date.parse(iso) || 0;

function rowOf(line: GateLedgerLine): Row | undefined {
  let v: unknown = line.record;
  if (v === undefined && line.text !== undefined) {
    try {
      v = JSON.parse(line.text);
    } catch {
      return undefined;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : undefined;
}

function sealOf(r: Row): { seal: GateAuditSeal; sealed?: true; signer?: string } {
  const s = r.seal as { signature?: unknown; signer?: unknown } | null | undefined;
  const signed = s && s.signature ? { sealed: true as const, ...(str(s.signer) ? { signer: str(s.signer) } : {}) } : undefined;
  if (r.review || r.via === "pr-review") return { seal: "review", ...signed };
  return signed ? { seal: "sealed", ...signed } : { seal: "unsigned" };
}

function reviewOf(r: Row): GateAuditEntry["review"] {
  const rv = (r.review ?? undefined) as Row | undefined;
  const pr = typeof rv?.pr === "number" ? rv.pr : typeof r.pr === "number" ? r.pr : undefined;
  const head = str(rv?.head) ?? str(r.head);
  const approvers = strings(rv?.approvers) ?? strings(r.reviewers);
  if (pr === undefined && head === undefined && approvers === undefined) return undefined;
  return { ...(pr !== undefined ? { pr } : {}), ...(head ? { head } : {}), ...(approvers ? { approvers } : {}) };
}

function approverOf(r: Row): GateAuditEntry["approver"] {
  const a = r.approver as { kind?: unknown; roles?: unknown } | undefined;
  if (!a || typeof a.kind !== "string") return undefined;
  const roles = strings(a.roles);
  return { kind: a.kind, ...(roles ? { roles } : {}) };
}

const drop = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const idOf = (...parts: unknown[]): string => contentDigest(canonicalJson(parts));

interface Seen {
  op: string;
  gate: string;
  at: number;
  digest?: string;
  environment?: string;
}

/** Whether two digests, either absent, can be the same plan: absent matches anything, as an old line records none. */
const compatible = (a: string | undefined, b: string | undefined): boolean => a === undefined || b === undefined || samePlanDigest(a, b);

/** The entries `input` adds up to, oldest first, and the gaps they show. */
export function deriveGateAudit(input: GateAuditInput): { entries: GateAuditEntry[]; gaps: GateAuditGap[] } {
  const isOverride = input.isOverride ?? isOverrideGate;
  const rekey = input.id;
  const keyed = (e: GateAuditEntry): GateAuditEntry => (rekey ? { ...e, id: rekey(e) } : e);
  const entries: GateAuditEntry[] = [];
  const gaps: GateAuditGap[] = [];

  for (const ledger of input.ledgers) {
    const path = ledger.path ?? `_gates/${ledger.op}.jsonl`;
    const parsed: { line: GateLedgerLine; n: number; r: Row; pending: boolean }[] = [];
    for (const [i, line] of ledger.lines.entries()) {
      const r = rowOf(line);
      const pending = r?.kind === "pending";
      const ok = r && r.version === 1 && typeof r.gate === "string" && typeof r.timestamp === "string" && (pending || typeof r.resolvedBy === "string");
      if (!r || !ok) {
        gaps.push({ kind: "malformed-line", op: ledger.op, detail: `${path} holds a line that is not a gate record${line.commit ? ` (commit ${line.commit})` : ""}: ${(line.text ?? JSON.stringify(line.record) ?? "").slice(0, 80)}` });
        continue;
      }
      parsed.push({ line, n: line.line ?? i + 1, r, pending });
    }

    // Each denial an override answers: the newest pending fact of its gate and digest.
    const denials = new Map<string, Row>();
    const requests: Seen[] = [];
    for (const p of parsed) {
      if (!p.pending || p.line.removed) continue;
      const digest = str(p.r.planDigest);
      denials.set(`${String(p.r.gate)}\n${digest ?? ""}`, p.r);
      requests.push({ op: ledger.op, gate: String(p.r.gate), at: time(String(p.r.timestamp)), ...(digest ? { digest } : {}), ...(str(p.r.environment) ? { environment: str(p.r.environment) } : {}) });
    }

    for (const { line, n, r, pending } of parsed) {
      const gate = String(r.gate);
      const override = isOverride(ledger.op, gate);
      const removed = line.removed;
      if (pending && removed) continue;
      const digest = str(r.planDigest);
      const author = removed ?? line.added;
      const source: GateAuditSource = {
        path,
        op: ledger.op,
        line: n,
        ...(line.text !== undefined ? { text: line.text } : {}),
        ...(line.commit ? { commit: line.commit } : {}),
        ...(author ? { author } : {}),
        change: removed ? "removed" : "added",
      };
      const id = idOf(removed ? "removed" : "ledger", path, line.commit ?? null, r);
      const extra = Object.fromEntries(Object.entries(r).filter(([k]) => !KNOWN.has(k)));
      const base = { id, gate, op: ledger.op, ...(digest ? { digest } : {}), source } as const;

      if (pending) {
        entries.push(keyed({
          ...base,
          kind: override ? "override-requested" : "approval-requested",
          at: String(r.timestamp),
          ...drop({ runId: str(r.runId), expiresAt: str(r.expiresAt), description: str(r.description), url: str(r.url), rules: strings(r.rules) }),
          detail: extra,
        }));
        continue;
      }

      const { seal, sealed, signer } = sealOf(r);
      if (removed) {
        entries.push(keyed({
          ...base,
          kind: "revoked",
          at: removed.at,
          ...(removed.by ? { by: removed.by } : {}),
          subject: override ? "override" : "approval",
          seal,
          ...(sealed ? { sealed } : {}),
          detail: { ...extra, approvedBy: r.resolvedBy, approvedAt: r.timestamp, ...(signer ? { signer } : {}) },
        }));
        continue;
      }

      const denial = override ? denials.get(`${gate}\n${digest ?? ""}`) : undefined;
      const rules = strings(denial?.rules) ?? (override && gate.startsWith("override-") ? [gate.slice("override-".length)] : undefined);
      const entry: GateAuditEntry = keyed({
        ...base,
        kind: override ? "override-recorded" : "approved",
        at: String(r.timestamp),
        by: String(r.resolvedBy),
        seal,
        ...drop({ sealed, signer, committedBy: line.added?.by, relayedBy: str(r.relayedBy), approver: approverOf(r), note: str(r.note), url: str(r.url), review: reviewOf(r), rules }),
        detail: extra,
      });
      entries.push(entry);

      if (!override) {
        const at = time(entry.at);
        const env = str(r.environment);
        const asked = requests.some((q) => q.gate === gate && q.at <= at && compatible(q.digest, digest) && (q.environment === undefined || env === undefined || q.environment === env));
        if (!asked) {
          gaps.push({ kind: "approval-without-request", op: ledger.op, gate, ...(digest ? { digest } : {}), detail: `${path} holds an approval of ${gate} by ${entry.by} at ${entry.at} with no pending fact of that gate${digest ? " and digest" : ""} before it` });
        }
      }
      if (seal === "unsigned" && input.sealed?.(ledger.op, gate)) {
        gaps.push({ kind: "unsealed", op: ledger.op, gate, ...(digest ? { digest } : {}), detail: `${path} holds ${override ? "an override" : "an approval"} of ${gate} by ${entry.by} at ${entry.at} with no seal and no review, and the gate needs one` });
      }
    }
  }

  const held = entries.filter((e) => e.kind === "approved" || e.kind === "override-recorded");
  for (const a of input.applies ?? []) {
    const base = { gate: a.gate, ...(a.op ? { op: a.op } : {}), ...(a.digest ? { digest: a.digest } : {}), source: { path: a.ref, ...(a.op ? { op: a.op } : {}), change: "apply" as const } };
    const at = time(a.at);
    const find = (kind: GateAuditKind, gate: string, digest: string | undefined, before: boolean): GateAuditEntry | undefined =>
      held
        .filter((e) => e.kind === kind && e.gate === gate && (a.op === undefined || e.op === a.op) && (digest === undefined ? true : e.digest !== undefined && samePlanDigest(e.digest, digest)) && (!before || time(e.at) <= at))
        .sort((x, y) => time(y.at) - time(x.at))[0];

    const approval = a.digest !== undefined && a.approval !== "not-required" ? find("approved", a.gate, a.digest, true) : undefined;
    if (a.digest !== undefined && a.approval !== "not-required" && !approval) {
      gaps.push({ kind: "approval", ...(a.op ? { op: a.op } : {}), gate: a.gate, digest: a.digest, detail: `${a.ref} applied under ${a.digest}, but the ledger holds no approval of ${a.gate} for that digest before ${a.at}` });
    }
    entries.push(keyed({
      ...base,
      id: idOf("apply", a.ref, a.at, a.gate, a.digest ?? null),
      kind: "applied",
      at: a.at,
      ...(a.by ? { by: a.by } : {}),
      ...(approval ? { under: approval.id } : {}),
      detail: { ...(a.detail ?? {}), approval: a.approval ?? "required" },
    }));

    for (const o of a.overrides ?? []) {
      const recorded = find("override-recorded", o.gate, o.digest, false);
      if (!recorded) {
        gaps.push({ kind: "override", ...(a.op ? { op: a.op } : {}), gate: o.gate, ...(o.digest ? { digest: o.digest } : {}), detail: `${a.ref} cites the override ${o.gate}${o.digest ? ` for ${o.digest}` : ""}, but the ledger holds none` });
        continue;
      }
      entries.push(keyed({
        ...base,
        id: idOf("spent", a.ref, a.at, recorded.id),
        kind: "override-spent",
        gate: o.gate,
        at: a.at,
        ...(recorded.by ? { by: recorded.by } : {}),
        ...(recorded.digest ? { digest: recorded.digest } : {}),
        under: recorded.id,
        detail: {},
      }));
    }
  }

  entries.sort((x, y) => time(x.at) - time(y.at));
  return { entries, gaps };
}

/** The lines of one ledger file's text, all added, each with its line number. Blank lines are skipped. */
export function gateLedgerLines(content: string): GateLedgerLine[] {
  return content.split("\n").flatMap((l, i) => (l.trim() ? [{ text: l.trim(), line: i + 1 }] : []));
}

/**
 * The lines each commit added to and removed from a ledger file, oldest first,
 * from `git log -p --unified=0 --no-renames` written with
 * `--format=%x1e%H%x1f%an%x1f%aI` over the file (append `%x1f%ae` for the
 * author's email). The caller runs git; this reads the text. Each line keeps
 * its commit and that commit's date and author, as `added` or `removed`. A
 * line removed and added again in one commit (a newline fixed at the end of
 * the file) is neither. A removed line is what {@link deriveGateAudit}
 * reports as a revocation.
 */
export function gateLedgerLinesFromLog(log: string): GateLedgerLine[] {
  const out: GateLedgerLine[] = [];
  for (const block of log.split("\x1e").slice(1)) {
    const [head = "", ...rest] = block.split("\n");
    const [commit = "", author = "", date = "", email = ""] = head.split("\x1f");
    const net = new Map<string, number>();
    const order: string[] = [];
    for (const l of rest) {
      const sign = l[0];
      if ((sign !== "+" && sign !== "-") || l[1] !== "{") continue;
      const text = l.slice(1).trim();
      if (!net.has(text)) order.push(text);
      net.set(text, (net.get(text) ?? 0) + (sign === "+" ? 1 : -1));
    }
    const when = Date.parse(date.trim());
    const at = Number.isNaN(when) ? date.trim() : new Date(when).toISOString();
    const by: GateLedgerCommit = { at, ...(author ? { by: author } : {}), ...(email.trim() ? { email: email.trim() } : {}) };
    for (const text of order) {
      const n = net.get(text)!;
      for (let i = 0; i < Math.abs(n); i++) {
        out.push({ text, commit: commit.trim(), ...(n > 0 ? { added: { ...by } } : { removed: { ...by } }) });
      }
    }
  }
  return out;
}

/**
 * The thin reader: each op's ledger through a {@link GateLedgerPort} (the git
 * port, or the in-memory one in a test), as input for {@link deriveGateAudit}.
 * The port holds the file as it stands, so nothing here is revoked; add
 * history through {@link gateLedgerLinesFromLog} for that.
 */
export async function readGateAuditLedgers(port: Pick<GateLedgerPort, "read">, ops: readonly string[]): Promise<GateAuditLedger[]> {
  const out: GateAuditLedger[] = [];
  for (const op of ops) {
    const { resolutions, pending } = await port.read(op);
    out.push({ op, lines: [...pending, ...resolutions].map((record) => ({ record })) });
  }
  return out;
}
