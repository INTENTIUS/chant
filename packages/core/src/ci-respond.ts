/**
 * Responses to pipeline events (#4629), in CI core so terragucci and plywood
 * answer the same events the same way, each in its own words.
 *
 * - `wave-refused: diff`: a wave that applied nothing because its plan moved
 *   since the approval, another run held it, or its decision point declined
 *   it posts which members moved and what moved in them, from the approved
 *   change set and the current one.
 * - `apply-failed: triage`: a failed apply posts the members and resources
 *   that failed with the engine's error, from the run record (an op wave's)
 *   or the apply report (`pr-apply`'s).
 * - `description: check`: with a decide service set, the plan-note job asks
 *   whether the pull request's title and description leave out what its
 *   change set destroys or replaces, and posts the finding. It never
 *   approves, gates or blocks anything.
 *
 * The first two are on by default and the third is off. Each one is turned
 * off (or on) with a list such as `wave-refused=off,description=check`: the
 * `--respond` flag, the `CHANT_RESPOND` variable a generated job sets, or an
 * op waves spec's `respond`.
 *
 * Every post is one comment per event and place, found again by its marker,
 * so a job that runs twice edits its comment. Delivery never throws and never
 * changes a job's exit code.
 */

import type { ChangeSetAttribute, ChangeSetDocument, ChangeSetEntry } from "./change-set";
import { activeProductWords, type CiProductWords } from "./ci-product-words";
import type { PrForge } from "./pr-forge";

/** The events chant answers. */
export type CiRespondEvent = "wave-refused" | "apply-failed" | "description";

/** Each event's modes; the first is its default. */
export const CI_RESPONSES = {
  "wave-refused": ["diff", "off"],
  "apply-failed": ["triage", "off"],
  description: ["off", "check"],
} as const satisfies Record<CiRespondEvent, readonly string[]>;

export type CiResponses = { [E in CiRespondEvent]?: (typeof CI_RESPONSES)[E][number] };

/** The variable a generated job carries its responses in. */
export const CI_RESPOND_ENV = "CHANT_RESPOND";

/** Every event at its default. */
export const CI_RESPOND_DEFAULTS: Required<CiResponses> = { "wave-refused": "diff", "apply-failed": "triage", description: "off" };

/** `wave-refused=off,description=check` as responses, or why it is not a list of them. */
export function parseRespondList(text: string | readonly string[]): CiResponses | { error: string } {
  const parts = (typeof text === "string" ? text.split(",") : text.flatMap((t) => t.split(","))).map((p) => p.trim()).filter(Boolean);
  const out: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    const event = eq < 0 ? part : part.slice(0, eq);
    const mode = eq < 0 ? "" : part.slice(eq + 1);
    if (!(event in CI_RESPONSES)) return { error: `--respond names no event ${JSON.stringify(event)}; the events are ${Object.keys(CI_RESPONSES).join(", ")}` };
    const modes = CI_RESPONSES[event as CiRespondEvent] as readonly string[];
    if (!modes.includes(mode)) return { error: `--respond ${event} takes ${modes.join(" or ")}, not ${JSON.stringify(mode)}` };
    out[event] = mode;
  }
  return out as CiResponses;
}

/** The list form of `responses`, for `--respond` and {@link CI_RESPOND_ENV}. Empty when every event is at its default. */
export function respondList(responses: CiResponses): string {
  return (Object.keys(CI_RESPONSES) as CiRespondEvent[])
    .filter((e) => responses[e] !== undefined && responses[e] !== CI_RESPOND_DEFAULTS[e])
    .map((e) => `${e}=${responses[e]}`)
    .join(",");
}

/**
 * The responses in force: the defaults, then `CHANT_RESPOND`, then the
 * spec's or the flag's. A malformed variable is ignored with a warning,
 * since a response never stops a job.
 */
export function resolveResponses(given: CiResponses | undefined, env: Record<string, string | undefined> = process.env, warn: (line: string) => void = () => {}): Required<CiResponses> {
  let fromEnv: CiResponses = {};
  const raw = env[CI_RESPOND_ENV];
  if (raw) {
    const parsed = parseRespondList(raw);
    if ("error" in parsed) warn(`${CI_RESPOND_ENV} is ignored: ${parsed.error}`);
    else fromEnv = parsed;
  }
  return { ...CI_RESPOND_DEFAULTS, ...fromEnv, ...(given ?? {}) } as Required<CiResponses>;
}

/** The hidden marker of one response's comment. */
export function respondMarker(event: CiRespondEvent, place: string): string {
  return `<!-- chant:respond:${event}:${place.replace(/[^A-Za-z0-9._/-]/g, "_")} -->`;
}

// ---------------------------------------------------------------------------
// wave-refused: diff
// ---------------------------------------------------------------------------

/** Why a wave applied nothing. */
export type RefusedReason = "moved" | "held" | "declined";

/** One entry whose plan moved between the approved change set and the current one. */
export interface RefusedEntryDiff {
  address: string;
  /** Its action in the approved plan; absent when the entry is new. */
  was?: string;
  /** Its action now; absent when it is gone. */
  now?: string;
  /** Attributes whose planned value differs. */
  attributes: string[];
}

/** One member whose plan moved. */
export interface RefusedMemberDiff {
  member: string;
  approved: string | null;
  current: string | null;
  /** Entry by entry, when both change sets were read; empty otherwise. */
  changes: RefusedEntryDiff[];
}

export interface RefusedDiff {
  /** How the post names the wave or the apply, such as `wave 2 (prod) of plywood-up`. */
  label: string;
  reason: RefusedReason;
  approved: string | null;
  current: string | null;
  members: RefusedMemberDiff[];
  /** The holder or the decision, for `held` and `declined`. */
  detail?: string;
}

const shown = (a: ChangeSetAttribute | undefined): string | undefined =>
  a === undefined ? undefined : a.sensitive ? "(sensitive)" : a.unknown ? "(known after apply)" : JSON.stringify(a.after ?? null);

function entryDiffs(was: readonly ChangeSetEntry[], now: readonly ChangeSetEntry[]): RefusedEntryDiff[] {
  const key = (e: ChangeSetEntry) => `${e.address}\u0000${e.deposed ?? ""}`;
  const before = new Map(was.map((e) => [key(e), e]));
  const after = new Map(now.map((e) => [key(e), e]));
  const out: RefusedEntryDiff[] = [];
  for (const k of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(k);
    const a = after.get(k);
    const paths = new Set([...(b?.attributes ?? []).map((x) => x.path), ...(a?.attributes ?? []).map((x) => x.path)]);
    const moved = [...paths].filter((p) => shown(b?.attributes.find((x) => x.path === p)) !== shown(a?.attributes.find((x) => x.path === p))).sort();
    if (b?.action === a?.action && moved.length === 0) continue;
    out.push({ address: (a ?? b)!.address, ...(b ? { was: b.action } : {}), ...(a ? { now: a.action } : {}), attributes: moved });
  }
  return out;
}

/**
 * The members whose plan digest differs between the approved change set and
 * the current one, entry by entry. `only` narrows to the members a wave
 * holds. A member that planned the same in both is left out.
 */
export function changeSetDiff(approved: ChangeSetDocument | undefined, current: ChangeSetDocument | undefined, only?: readonly string[]): RefusedMemberDiff[] {
  const names = new Set([...(approved?.members ?? []).map((m) => m.member), ...(current?.members ?? []).map((m) => m.member)]);
  const keep = only ? new Set(only) : undefined;
  const out: RefusedMemberDiff[] = [];
  for (const member of [...names].sort()) {
    if (keep && !keep.has(member)) continue;
    const was = approved?.members.find((m) => m.member === member)?.planDigest ?? null;
    const now = current?.members.find((m) => m.member === member)?.planDigest ?? null;
    if (was === now && was !== null) continue;
    const changes = approved && current ? entryDiffs(approved.entries.filter((e) => e.member === member), current.entries.filter((e) => e.member === member)) : [];
    out.push({ member, approved: was, current: now, changes });
  }
  return out;
}

/** The members whose plan digest differs, when only the digests are known (an op wave's decision against its share job's plans). */
export function digestDiff(approved: Readonly<Record<string, string | null>>, current: Readonly<Record<string, string | null>>): RefusedMemberDiff[] {
  return [...new Set([...Object.keys(approved), ...Object.keys(current)])]
    .sort()
    .filter((m) => approved[m] !== current[m] || approved[m] == null)
    .map((member) => ({ member, approved: approved[member] ?? null, current: current[member] ?? null, changes: [] }));
}

/** A digest's first 12 hex characters past its scheme; `none` when there is none. */
export const shortDigest = (d: string | null | undefined): string => (d ? d.slice(d.lastIndexOf(":") + 1).slice(0, 12) : "none");

/** The post for a refused wave or apply, in the product's words. */
export function renderRefusedDiff(d: RefusedDiff, words: CiProductWords = activeProductWords()): string {
  const [, applied] = words.verbs.apply;
  const [nounOne, nounMany] = words.noun;
  const lines: string[] = [];
  if (d.reason === "moved") {
    lines.push(`${capital(d.label)} ${applied} nothing: its plans changed after the approval (approved ${shortDigest(d.approved)}, now ${shortDigest(d.current)}).`);
  } else if (d.reason === "held") {
    lines.push(`${capital(d.label)} ${applied} nothing: another run holds what it changes${d.detail ? ` (${d.detail})` : ""}.`);
  } else {
    lines.push(`${capital(d.label)} ${applied} nothing: its decision point declined it${d.detail ? ` (${d.detail})` : ""}.`);
  }
  if (d.members.length === 0) {
    if (d.reason === "moved") lines.push("", `No ${nounOne}'s plan differs from the approved change set that could be read.`);
  } else {
    lines.push("", `${d.members.length === 1 ? capital(nounOne) : capital(nounMany)} whose plan differs from the approved one:`, "");
    for (const m of d.members) {
      lines.push(`- \`${m.member}\`: plan ${shortDigest(m.approved)} -> ${shortDigest(m.current)}`);
      for (const c of m.changes) {
        const action = c.was === c.now ? c.now : `${c.was ?? "none"} -> ${c.now ?? "none"}`;
        lines.push(`  - \`${c.address}\` ${action}${c.attributes.length ? `: ${c.attributes.join(", ")}` : ""}`);
      }
      if (m.current === null) lines.push(`  - it did not ${words.verbs.plan[0]} this time`);
    }
  }
  if (d.reason === "moved") lines.push("", "Approve again only once the new plan is the one you want.");
  else if (d.reason === "held") lines.push("", `Run it again once the other run is done; the approval still stands.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// apply-failed: triage
// ---------------------------------------------------------------------------

/** One member that failed to apply. */
export interface FailedMember {
  member: string;
  /** The engine's error, as the run record or the report has it. */
  error?: string;
  /** The resources the engine reported failed, when it reports per resource. */
  resources?: string[];
}

export interface FailedApply {
  label: string;
  exitCode: number;
  members: FailedMember[];
  /** A failure outside any member: a hook, the job's own error. */
  error?: string;
}

/** The longest error kept per member, so one engine's dump cannot fill the comment. */
const ERROR_LIMIT = 2000;

const clip = (text: string): string => (text.length > ERROR_LIMIT ? `${text.slice(0, ERROR_LIMIT)}\n... (cut at ${ERROR_LIMIT} characters; the job's log has the rest)` : text);

/** The post for a failed apply, in the product's words. */
export function renderTriage(f: FailedApply, words: CiProductWords = activeProductWords()): string {
  const [apply] = words.verbs.apply;
  const [nounOne, nounMany] = words.noun;
  const lines = [`${capital(f.label)} failed (exit ${f.exitCode}).`];
  if (f.members.length > 0) {
    lines.push("", `${f.members.length === 1 ? capital(nounOne) : capital(nounMany)} that did not ${apply}:`);
    for (const m of f.members) {
      lines.push("", `- \`${m.member}\``);
      if (m.resources?.length) lines.push(`  - failed resources: ${m.resources.map((r) => `\`${r}\``).join(", ")}`);
      if (m.error) lines.push("", "```", clip(m.error).replaceAll("```", "'''"), "```");
    }
  }
  if (f.error) lines.push("", "```", clip(f.error).replaceAll("```", "'''"), "```");
  lines.push("", `What applied before the failure stays applied. Fix the cause and ${apply} again; the run record keeps every ${nounOne}'s outcome.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// description: check
// ---------------------------------------------------------------------------

/** What the model reads: the pull request's text and the change set's summary. No planned values. */
export interface DescriptionState {
  title: string;
  description: string;
  plan: { counts: Record<"create" | "update" | "replace" | "delete", number>; destroys: string[]; replacements: string[] };
}

const MAX_TEXT = 4000;
const MAX_LISTED = 50;

const named = (e: Pick<ChangeSetEntry, "member" | "address">): string => `${e.member}: ${e.address}`;

/** The destroys and replacements of a change set. */
export function destructiveEntries(doc: ChangeSetDocument): { destroys: ChangeSetEntry[]; replacements: ChangeSetEntry[] } {
  return { destroys: doc.entries.filter((e) => e.action === "delete"), replacements: doc.entries.filter((e) => e.action === "replace") };
}

export function descriptionState(doc: ChangeSetDocument, title: string, description: string): DescriptionState {
  const { destroys, replacements } = destructiveEntries(doc);
  const a = doc.summary.actions;
  return {
    title: title.slice(0, MAX_TEXT),
    description: description.slice(0, MAX_TEXT),
    plan: {
      counts: { create: a.create ?? 0, update: a.update ?? 0, replace: a.replace ?? 0, delete: a.delete ?? 0 },
      destroys: destroys.slice(0, MAX_LISTED).map(named),
      replacements: replacements.slice(0, MAX_LISTED).map(named),
    },
  };
}

/** Whether the text names an entry by its address, its type or its member. */
function mentions(text: string, e: ChangeSetEntry): boolean {
  const hay = text.toLowerCase();
  return [e.address, e.address.replace(/\[.*$/, ""), e.name, e.type].some((s) => typeof s === "string" && s.length > 2 && hay.includes(s.toLowerCase()));
}

/** The destroys and replacements the text does not mention; every one when it names them all, since the model found the text leaves something out. */
export function unmentioned(doc: ChangeSetDocument, text: string): ChangeSetEntry[] {
  const { destroys, replacements } = destructiveEntries(doc);
  const all = [...destroys, ...replacements];
  const left = all.filter((e) => !mentions(text, e));
  return left.length > 0 ? left : all;
}

/** The question asked. A Noul: the probability the answer is yes. */
export const DESCRIPTION_QUESTION = {
  type: "noul",
  instructions:
    "Read the pull request's title and description and the summary of its plan. Answer true when the plan destroys or replaces resources that the title and description do not mention or that they contradict. Answer false when the text covers every destroy and replacement, or the plan has none.",
  criteria: {
    true: "the plan destroys or replaces something the text leaves out or contradicts",
    false: "the text describes every destroy and replacement, or there are none",
  },
} as const;

/** The default probability a yes needs before the finding is posted. */
export const DESCRIPTION_THRESHOLD = 0.8;

/** The model call: the backend's answer to {@link DESCRIPTION_QUESTION} over the state, as a probability of yes. */
export type DescriptionAsk = (state: DescriptionState) => Promise<{ model: string; probability: number; reason?: string }>;

export interface DescriptionFinding {
  /** `flagged`: the finding was posted. `clear`: the model said no, or not confidently. `skipped`: nothing to check. `error`: the service did not answer. */
  status: "flagged" | "clear" | "skipped" | "error";
  probability?: number;
  model?: string;
  reason?: string;
  unmentioned: string[];
  /** The post, when flagged. */
  body?: string;
}

/** Ask whether the description leaves out a destroy or replacement. Never throws. */
export async function checkDescription(input: {
  doc: ChangeSetDocument;
  title: string;
  description: string;
  ask: DescriptionAsk;
  threshold?: number;
  words?: CiProductWords;
}): Promise<DescriptionFinding> {
  const { destroys, replacements } = destructiveEntries(input.doc);
  if (destroys.length + replacements.length === 0) return { status: "skipped", reason: "the plan destroys and replaces nothing", unmentioned: [] };
  let answer: Awaited<ReturnType<DescriptionAsk>>;
  try {
    answer = await input.ask(descriptionState(input.doc, input.title, input.description));
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : String(err), unmentioned: [] };
  }
  const threshold = input.threshold ?? DESCRIPTION_THRESHOLD;
  const base = { probability: answer.probability, model: answer.model, ...(answer.reason ? { reason: answer.reason } : {}) };
  if (!(answer.probability >= threshold)) return { status: "clear", ...base, unmentioned: [] };
  const left = unmentioned(input.doc, `${input.title}\n${input.description}`);
  const names = left.map(named);
  return { status: "flagged", ...base, unmentioned: names, body: renderDescriptionFinding(left, base, input.words ?? activeProductWords()) };
}

function renderDescriptionFinding(left: readonly ChangeSetEntry[], answer: { probability: number; model: string; reason?: string }, words: CiProductWords): string {
  const list = left.slice(0, 10).map((e) => `- \`${named(e).replaceAll("`", "'")}\` (${e.action === "replace" ? "replace" : "destroy"})`);
  if (left.length > 10) list.push(`- and ${left.length - 10} more in the plan note`);
  return [
    `Check the description of this pull request. The ${words.verbs.plan[0]} makes changes it does not mention:`,
    "",
    ...list,
    "",
    `${answer.model} answered yes with probability ${answer.probability.toFixed(2)}${answer.reason ? `: ${answer.reason}` : ""}. This finding approves nothing and never blocks a merge.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/** Where a response goes: a pull request, or a tracking issue when the run has none. */
export type RespondPlace = { pr: number } | { issue: string };

/** What {@link postResponse} did. */
export interface RespondPost {
  posted: boolean;
  url?: string;
  warning?: string;
}

/**
 * Post one response's body, editing its earlier comment. On a pull request
 * the comment carries the marker as its first line; with no pull request it
 * goes to a tracking issue titled `issue`. Never throws.
 */
export async function postResponse(
  forge: Pick<PrForge, "upsertComment" | "trackIssue">,
  event: CiRespondEvent,
  place: string,
  where: RespondPlace,
  body: string,
): Promise<RespondPost> {
  const marker = respondMarker(event, place);
  const text = `${marker}\n${body}${body.endsWith("\n") ? "" : "\n"}`;
  try {
    if ("pr" in where) {
      const r = await forge.upsertComment(where.pr, marker, text);
      return { posted: true, ...(r.url ? { url: r.url } : {}) };
    }
    const r = await forge.trackIssue(marker, { title: where.issue, body: text }, { match: "anywhere" });
    return { posted: true, ...(r.url ? { url: r.url } : {}) };
  } catch (err) {
    return { posted: false, warning: `could not post the ${event} response: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function capital(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
