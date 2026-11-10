/**
 * One drift issue per environment (#4790).
 *
 * plywood, SQL Yodeler and terragucci each kept a tracking issue for an
 * environment's drift through the forge client's `trackIssue` (#3759), and
 * each wrote the rest itself: the hidden marker that finds the issue again,
 * a fingerprint of the drift so a run that finds the same drift does not
 * edit the issue, the body, and the comment that closes the issue when the
 * drift clears. {@link keepDriftIssue} is that, once. A product passes its
 * words and the run's drift records, and the call decides:
 *
 * - drift found (a record `drifted` or `missing`): open the issue, or update
 *   the open one when the fingerprint or the title changed. An issue that
 *   already carries the fingerprint is left as it is, so a body that names
 *   the run or the time does not edit it on every scheduled run;
 * - no drift, and every record was read: close the open issue with the
 *   product's comment;
 * - no drift, and a record is `not-observed`, or the caller says the read
 *   failed (`unknown`): leave the open issue as it is. A read that proves
 *   nothing neither closes nor opens one.
 *
 * Only open issues are read, so an issue closed by hand stays closed and the
 * next drift opens a new one. It runs on GitHub, GitLab and Forgejo through
 * any client with `trackIssue` (`@intentius/chant/pr-forge`), and needs no
 * read of its own.
 *
 * ```ts
 * import { forgeClient, forgeTargetFromEnv } from "@intentius/chant/pr-forge";
 * import { keepDriftIssue } from "@intentius/chant/drift-issue";
 *
 * const forge = forgeClient(forgeTargetFromEnv(process.env, { kind: "github" }));
 * const r = await keepDriftIssue(forge, { words, environment: "acme/prod", records });
 * ```
 *
 * The module imports types only, apart from `node:crypto`, so a product's
 * bundle gains this file and nothing else (`drift-issue-bundle.test.ts`).
 */

import { createHash } from "node:crypto";
import type { DriftAttribute, DriftRecord, DriftStatus } from "./drift-record";
import type { IssueResult, MarkerMatch, PrForge } from "./pr-forge";

/** The statuses that are drift for the issue: present and different, or gone. */
export const DRIFT_ISSUE_STATUSES: readonly DriftStatus[] = ["drifted", "missing"];

/** What the issue reads of a record. Any {@link DriftRecord} is one. */
export type DriftIssueRecord = Pick<DriftRecord, "member" | "address" | "status"> & Partial<Pick<DriftRecord, "resourceType" | "attributes" | "unobserved" | "observedAt">>;

/** What the issue says about the environment, for {@link DriftIssueWords}. */
export interface DriftIssueFacts {
  environment: string;
  /** The records that are drift, sorted by member and address. */
  drifted: readonly DriftIssueRecord[];
  /** The latest `observedAt` among the records, else the caller's, else now. */
  observedAt: string;
}

/** A product's words for its drift issue. Only `product` and `title` are required. */
export interface DriftIssueWords {
  /** The marker's and fingerprint's namespace, and the name in chant's default sentences: `plywood`, `yodel`, `terragucci`. */
  product: string;
  /** The issue's title. It may name what drifted; a new title updates the issue. */
  title: (facts: DriftIssueFacts) => string;
  /** The paragraph above the table. Default: `<product>'s drift check read <env> at <time> and found N resources that differ.` */
  intro?: (facts: DriftIssueFacts) => string;
  /** The table's first column. Default `Address`; plywood's is `URN`. */
  address?: string;
  /**
   * The words for an attribute's two values, as `declared` and `live`. With
   * them each attribute shows its values, `` `path`: declared `a`, live `b` ``;
   * without them only its path. A sensitive attribute never shows a value.
   */
  values?: { before: string; after: string };
  /** The heading over the records that could not be read. Default `Could not be read, so their state is unknown:`. */
  unobserved?: string;
  /** The paragraph below the table: how to correct the drift. */
  advice?: (facts: DriftIssueFacts) => string;
  /** The line that names the run. Default `Found by <url>.` */
  foundBy?: (runUrl: string) => string;
  /** The comment posted when the drift clears and the issue is closed. Default: `<product>'s drift check at <time> found <env> matching, so this issue is closed.` */
  cleared?: (facts: DriftIssueFacts) => string;
}

export interface DriftIssueInput {
  words: DriftIssueWords;
  /** The environment the issue is for: a stack, an environment name, a project and environment. Keys the default marker. */
  environment: string;
  /** The run's drift records for the environment. */
  records: readonly DriftIssueRecord[];
  /**
   * The read failed, and why: the open issue is left as it is, whatever
   * `records` holds.
   */
  unknown?: string;
  /**
   * The issue's marker, when the product's open issues already carry one of
   * their own (`<!-- yodel:drift project=. env=prod -->`). Default
   * {@link driftIssueMarker}`(product, environment)`.
   */
  marker?: string;
  /** The run's URL, for the line that names it. */
  runUrl?: string;
  /** Lines of the product's own below the table, such as who changed each attribute. */
  notes?: readonly string[];
  /** When the drift was read, when the records carry no `observedAt`. */
  observedAt?: string;
  /** How the marker is found, and whose issues count (`trackIssue`'s {@link MarkerMatch}). */
  match?: MarkerMatch;
  /**
   * The statuses that are drift. Default {@link DRIFT_ISSUE_STATUSES}. A
   * read with no snapshot gives a declared object the provider lacks as
   * `pending`, not deployed yet, unless its lexicon says such an object is
   * gone: the sql lexicon does since #4896, so its records say `missing`
   * and the default covers them. A caller that passes `pending` here (SQL
   * Yodeler did, for a chant before #4896) still gets the same issue.
   */
  statuses?: readonly DriftStatus[];
}

/** What {@link keepDriftIssue} did. */
export interface DriftIssueResult {
  /**
   * `opened`, `updated` or `unchanged` for drift; `closed` or `none` (no open
   * issue) when it cleared; `left` when the read proves nothing and an issue
   * is open, which stays as it is.
   */
  action: IssueResult["action"];
  number?: number;
  url?: string;
  created?: string;
  marker: string;
  /** The drift's fingerprint, when the run found drift. */
  fingerprint?: string;
  /** Why the issue was left as it is (`left`, or `none` with nothing open). */
  why?: string;
}

/** The hidden first line that finds the environment's drift issue again: `<!-- <product>:drift <environment> -->`. */
export function driftIssueMarker(product: string, environment: string): string {
  return `<!-- ${clean(product)}:drift ${clean(environment)} -->`;
}

/** The hidden line that carries the fingerprint, which an unchanged drift's issue already holds. */
export function driftFingerprintLine(product: string, fingerprint: string): string {
  return `<!-- ${clean(product)}:drift-fingerprint ${fingerprint} -->`;
}

/** The records that are drift, sorted by member and address. */
export function driftIssueRecords(records: readonly DriftIssueRecord[], statuses: readonly DriftStatus[] = DRIFT_ISSUE_STATUSES): DriftIssueRecord[] {
  return records.filter((r) => statuses.includes(r.status)).sort(byPlace);
}

/**
 * The drift's fingerprint: the same drift gives the same one, whenever and
 * in whatever order it is read. It covers each drifted or missing record's
 * member, address and status, and each attribute's path and, when the
 * record carries them, its two values. The time, the run, the records that
 * could not be read and those in sync are left out. 16 hex digits of a
 * SHA-256.
 */
export function driftIssueFingerprint(records: readonly DriftIssueRecord[], statuses: readonly DriftStatus[] = DRIFT_ISSUE_STATUSES): string {
  const text = driftIssueRecords(records, statuses)
    .map((r) => [r.member, r.address, r.status, ...attributesOf(r).map(attributeKey).sort()].join("\t"))
    .join("\n");
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** One stack's (or environment's) drift records, for {@link driftRunFingerprint}. */
export interface DriftRunStack {
  stack: string;
  records: readonly DriftIssueRecord[];
}

/**
 * A run's fingerprint over several stacks (#4896), for the drift notice a
 * run sends (`driftNotifyFields`'s `fingerprint` on
 * `@intentius/chant/ci-product`): each stack that has drift, as its name and
 * its {@link driftIssueFingerprint}, sorted and hashed. A stack with no
 * drift record is left out, so a clean stack, or one whose read failed and
 * gave no records, does not move it. 16 hex digits of a SHA-256, the value
 * plywood's notices carried before chant computed it.
 */
export function driftRunFingerprint(stacks: readonly DriftRunStack[], statuses: readonly DriftStatus[] = DRIFT_ISSUE_STATUSES): string {
  const parts = stacks
    .filter((s) => driftIssueRecords(s.records, statuses).length > 0)
    .map((s) => `${s.stack}\t${driftIssueFingerprint(s.records, statuses)}`)
    .sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/** The issue's body: the marker, the product's intro, the table, what could not be read, the notes, the advice, the run, the fingerprint. */
export function driftIssueBody(input: DriftIssueInput, fingerprint = driftIssueFingerprint(input.records, input.statuses)): string {
  const { words } = input;
  const facts = factsOf(input);
  const marker = input.marker ?? driftIssueMarker(words.product, input.environment);
  const members = new Set(facts.drifted.map((r) => r.member));
  const withMember = members.size > 1;
  const lines = [marker, words.intro ? words.intro(facts) : defaultIntro(words.product, facts), ""];
  lines.push(
    `| ${withMember ? "Member | " : ""}${words.address ?? "Address"} | Status | Attributes |`,
    `|${withMember ? "---|" : ""}---|---|---|`,
    ...facts.drifted.map((r) => `| ${withMember ? `${code(r.member)} | ` : ""}${code(r.address)} | ${r.status} | ${attributesOf(r).map((a) => attributeCell(a, words.values)).join(", ")} |`),
    "",
  );
  const unread = input.records.filter((r) => r.status === "not-observed").sort(byPlace);
  if (unread.length > 0) {
    lines.push(words.unobserved ?? "Could not be read, so their state is unknown:", "");
    for (const r of unread) lines.push(`- ${code(r.address)}${r.unobserved ? `: ${r.unobserved.reason}${r.unobserved.detail ? ` (${oneLine(r.unobserved.detail)})` : ""}` : ""}`);
    lines.push("");
  }
  if (input.notes?.length) lines.push(...input.notes, "");
  if (words.advice) lines.push(words.advice(facts), "");
  if (input.runUrl) lines.push(words.foundBy ? words.foundBy(input.runUrl) : `Found by ${input.runUrl}.`, "");
  lines.push(driftFingerprintLine(words.product, fingerprint));
  return lines.join("\n");
}

/**
 * Bring the environment's one drift issue in line with the run; see the
 * module comment for the three cases. Throws what the forge throws.
 */
export async function keepDriftIssue(forge: Pick<PrForge, "trackIssue">, input: DriftIssueInput): Promise<DriftIssueResult> {
  const { words } = input;
  const marker = input.marker ?? driftIssueMarker(words.product, input.environment);
  const match = input.match ?? {};
  const drifted = driftIssueRecords(input.records, input.statuses);
  const kept = (r: IssueResult, extra: Partial<DriftIssueResult> = {}): DriftIssueResult => ({
    action: r.action,
    ...(r.number !== undefined ? { number: r.number } : {}),
    ...(r.url ? { url: r.url } : {}),
    ...(r.created ? { created: r.created } : {}),
    marker,
    ...extra,
  });
  const unread = input.records.filter((r) => r.status === "not-observed").length;
  const why = input.unknown ?? (drifted.length === 0 && unread > 0 ? `${unread} resource${unread === 1 ? "" : "s"} could not be read, so whether ${input.environment} drifted is unknown` : undefined);
  if (why !== undefined) return kept(await forge.trackIssue(marker, null, match), { why });
  if (drifted.length > 0) {
    const fingerprint = driftIssueFingerprint(input.records, input.statuses);
    const body = driftIssueBody({ ...input, marker }, fingerprint);
    const r = await forge.trackIssue(marker, { title: words.title(factsOf(input)), body }, { ...match, sameWhen: driftFingerprintLine(words.product, fingerprint) });
    return kept(r, { fingerprint });
  }
  const facts = factsOf(input);
  const clearComment = words.cleared ? words.cleared(facts) : `${words.product}'s drift check at ${facts.observedAt} found ${input.environment} matching, so this issue is closed.`;
  return kept(await forge.trackIssue(marker, null, { ...match, closeOnClear: true, clearComment }));
}

function factsOf(input: DriftIssueInput): DriftIssueFacts {
  const times = input.records.map((r) => r.observedAt).filter((t): t is string => typeof t === "string").sort();
  return { environment: input.environment, drifted: driftIssueRecords(input.records, input.statuses), observedAt: times[times.length - 1] ?? input.observedAt ?? new Date().toISOString() };
}

function defaultIntro(product: string, facts: DriftIssueFacts): string {
  const n = facts.drifted.length;
  return `${product}'s drift check read ${facts.environment} at ${facts.observedAt} and found ${n} resource${n === 1 ? "" : "s"} that differ.`;
}

function attributesOf(r: DriftIssueRecord): readonly DriftAttribute[] {
  return [...(r.attributes ?? [])].sort((a, b) => compare(a.path, b.path));
}

function attributeKey(a: DriftAttribute): string {
  if (a.sensitive) return `${a.path}=sensitive`;
  return "before" in a || "after" in a ? `${a.path}=${JSON.stringify([a.before ?? null, a.after ?? null])}` : a.path;
}

function attributeCell(a: DriftAttribute, values: DriftIssueWords["values"]): string {
  if (!values) return code(a.path);
  if (a.sensitive) return `${code(a.path)} (sensitive)`;
  if (!("before" in a) && !("after" in a)) return code(a.path);
  return `${code(a.path)}: ${values.before} ${code(show(a.before))}, ${values.after} ${code(show(a.after))}`;
}

function show(v: unknown): string {
  return v === undefined ? "absent" : typeof v === "string" ? v : JSON.stringify(v);
}

/** Inline code that keeps a table cell's shape. */
function code(s: string): string {
  return `\`${oneLine(s).replace(/`/g, "'").replace(/\|/g, "\\|")}\``;
}

function oneLine(s: string): string {
  return s.replace(/\r?\n/g, " ");
}

/** A marker part that cannot end the comment or break the line. */
function clean(s: string): string {
  return s.replace(/-->/g, "").replace(/\s+/g, "_");
}

function byPlace(a: DriftIssueRecord, b: DriftIssueRecord): number {
  return compare(a.member, b.member) || compare(a.address, b.address);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
