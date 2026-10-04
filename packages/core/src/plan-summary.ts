/**
 * The grouped plan summary (#3188): a view over a change-set document
 * (`./change-set.ts`) that says how many members take the same change, which
 * take something more, and every destroy, replacement, failure and hole by
 * name. It is what reviewers read in an MR or PR note. Gates never bind it;
 * they bind the document's digest.
 *
 * ## What "the same change" means
 *
 * A unit is a member of the document, or, when the document has one member,
 * one resource instance of it; instances group only with instances of the
 * same expansion (the address with its instance keys removed). Two units
 * take the same change when their normalized changes are equal as
 * multisets. A normalized change is:
 *
 * - the action. `no-op` entries are dropped.
 * - the address, with every instance key removed and the unit's tokens
 *   stripped from module call names and the resource name. The type is
 *   never touched.
 * - each attribute the entry carries (the change-set adapters carry only
 *   the attributes a change writes), with the unit's tokens stripped from
 *   every string value. A sensitive attribute compares by its path alone,
 *   since the document carries no value for it.
 *
 * A unit's tokens are what names it: for a member, its scope (the estate or
 * environment) and the last path segment of its name; for an instance, its
 * own instance keys. Each is also tried with `-` and `_` swapped. A token
 * is stripped only where it stands as a whole word, and one under three
 * characters must also touch a `-` or `_`, so the key `1` leaves
 * `10.1.0.0/16` alone. choudoufu's `tofu-estate` and `tofu-address` markers
 * normalize away only when they hold the unit's own estate or address.
 * Nothing else is stripped.
 *
 * An `import` block, a forget (a `removed` block or `destroy = false`, the
 * plan action `forget`) and a triggered Terraform action (`action_invocations`)
 * each get a named list of their own. A forget is not a destroy and is never
 * in `destroys`; an import is part of its entry's change, so an entry that
 * imports never groups with the same change without the import, and a triggered
 * action is part of its unit's change the same way.
 *
 * These are choudoufu's rules for `live-summary` (choudoufu#1753). The two
 * implementations are kept together by one table of test vectors both run
 * (`__fixtures__/plan-summary/normalization-vectors.json`), per the ruling
 * recorded on #3188.
 *
 * ## The import graph
 *
 * terragucci runs this in customer CI from one bundled file (#3421). It
 * imports `./lifecycle/plan-digest` and types only, as `./change-set` does,
 * and `change-set-bundle.test.ts` holds that.
 */

import { computePlanDigest, PLAN_DIGEST_PREFIX } from "./lifecycle/plan-digest";
import type { ChangeSetAction, ChangeSetAttribute, ChangeSetDocument, ChangeSetEntry, ChangeSetMember, ChangeSetSideEffect } from "./change-set";

/** The schema a plan summary names in `$schema`. */
export const PLAN_SUMMARY_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/plan-summary/v1/plan-summary.schema.json";

/** The read-contract version the summary follows. */
export const PLAN_SUMMARY_CONTRACT = 1;

/**
 * The most characters a GitHub issue or pull request comment body may hold.
 * The REST API refuses a longer one with "Body is too long (maximum is 65536
 * characters)". GitHub documents no figure; this is the refusal's own.
 */
export const GITHUB_COMMENT_LIMIT = 65_536;

/**
 * The most characters a GitLab note may hold, merge-request notes included:
 * "Limited to 1,000,000 characters" (https://docs.gitlab.com/api/notes/).
 */
export const GITLAB_NOTE_LIMIT = 1_000_000;

/** What a group's units are: whole members, or the instances of one member. */
export type PlanSummaryUnit = "member" | "instance";

/** One distinct normalized change of a group. */
export interface PlanSummaryChange {
  /** What a reader sees: the action's symbol, the normalized address and the attributes written. */
  line: string;
  action: ChangeSetAction;
  /** How many times one unit makes this change. */
  count: number;
  /** The baseline group whose change at the same address and action this one differs from. */
  differsFrom?: string;
  /** The attributes it differs in. Values are never printed. */
  differsIn?: string[];
}

/** One destroy or replacement, by its real address. */
export interface PlanSummaryDestroy {
  member: string;
  address: string;
  type: string;
  action: "delete" | "replace";
  deposed?: string;
}

/** One resource an `import` block brings into state. */
export interface PlanSummaryImport {
  member: string;
  address: string;
  type: string;
  /** What else the plan does to it: `no-op` when the import changes nothing, else `update`, `create` and so on. */
  action: ChangeSetAction;
}

/** One resource a plan stops tracking and leaves running (`removed` with `destroy = false`). It is not a destroy. */
export interface PlanSummaryForget {
  member: string;
  address: string;
  type: string;
  deposed?: string;
}

/** A provider-defined side effect an apply runs: a triggered Terraform action. */
export type PlanSummarySideEffect = ChangeSetSideEffect;

export interface PlanSummaryGroup {
  /** Twelve hex characters over the group's normalized changes: the same change gets the same id in every run. */
  id: string;
  /** For instance groups, the expansion the instances belong to. */
  resource?: string;
  /** Member names, or instance addresses. */
  units: string[];
  /** A group of one beside other groups of the same expansion. */
  outlier: boolean;
  /** Units whose plans change nothing. */
  noChanges: boolean;
  changes: PlanSummaryChange[];
  /** The group whose whole change this one contains; `plus` is what it adds. */
  extends?: string;
  plus?: PlanSummaryChange[];
  /** Every destroy and replacement any unit of the group makes. */
  destroys: PlanSummaryDestroy[];
  /** Every triggered action any unit of the group runs. */
  sideEffects: PlanSummarySideEffect[];
}

/** A member that failed to plan. It is never in a group. */
export interface PlanSummaryFailure {
  member: string;
  scope?: string;
  reason: string;
}

/** An address a member's planner could not read. */
export interface PlanSummaryHole {
  member: string;
  address: string;
  type?: string;
  reason: string;
}

export interface PlanSummary {
  $schema: typeof PLAN_SUMMARY_SCHEMA_ID;
  contract: typeof PLAN_SUMMARY_CONTRACT;
  /** The digest of the change-set document summarized. */
  changeSet: string;
  unit: PlanSummaryUnit;
  /** Members, failed ones included, or the changing instances of the one member. */
  units: number;
  groups: PlanSummaryGroup[];
  failed: PlanSummaryFailure[];
  /** Every destroy and replacement in the document, failed members' included, sorted by member and address. */
  destroys: PlanSummaryDestroy[];
  /** Every import, in the document, sorted by member and address. Imports are never destroys. */
  imports: PlanSummaryImport[];
  /** Every forget in the document, sorted by member and address. A forget is never in `destroys`. */
  forgets: PlanSummaryForget[];
  /** Every triggered action in the document, sorted by member and address. */
  sideEffects: PlanSummarySideEffect[];
  holes: PlanSummaryHole[];
}

export interface GroupChangeSetOptions {
  /** `member` groups whole members; `instance` groups one member's instances. Default: `instance` for a one-member document, else `member`. */
  unit?: PlanSummaryUnit;
}

// ── normalization ────────────────────────────────────────────────────────────

const ESTATE = "<estate>";
const ADDRESS = "<address>";
const KEY = "<key>";
const UNKNOWN = "<known after apply>";

/** choudoufu's marker keys (choudoufu internal/live/markers). */
const TAG_ESTATE = "tofu-estate";
const TAG_ADDRESS = "tofu-address";
const ADDRESS_ANNOTATION = "choudoufu.intentius.io/tofu-address";
const MAX_CONTINUATIONS = 4;

interface Token {
  text: string;
  placeholder: string;
}

interface Identity {
  /** Longest first. */
  tokens: Token[];
  /** What a `tofu-estate` marker may hold and still normalize away. */
  estate?: string;
}

function identity(estate: string | undefined, keys: readonly string[], names: readonly string[]): Identity {
  const tokens: Token[] = [];
  const seen = new Set<string>();
  const add = (s: string, placeholder: string) => {
    for (const v of [s, s.replaceAll("-", "_"), s.replaceAll("_", "-")]) {
      if (v === "" || seen.has(v)) continue;
      seen.add(v);
      tokens.push({ text: v, placeholder });
    }
  };
  if (estate) add(estate, ESTATE);
  for (const n of names) add(n, ESTATE);
  for (const k of keys) add(k, KEY);
  tokens.sort((a, b) => b.text.length - a.text.length);
  return { tokens, ...(estate ? { estate } : {}) };
}

const isAlnum = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z0-9]$/.test(c);
const isJoin = (c: string | undefined): boolean => c === "-" || c === "_";

/** Replace `t` where it stands as a whole word; a token under three characters must also touch `-` or `_`. */
function replaceToken(s: string, t: Token): string {
  if (!s.includes(t.text)) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const j = s.indexOf(t.text, i);
    if (j < 0) {
      out += s.slice(i);
      break;
    }
    const end = j + t.text.length;
    let ok = !isAlnum(s[j - 1]) && !isAlnum(s[end]);
    if (ok && t.text.length < 3) ok = isJoin(s[j - 1]) || isJoin(s[end]);
    if (ok) {
      out += s.slice(i, j) + t.placeholder;
      i = end;
    } else {
      out += s.slice(i, j + 1);
      i = j + 1;
    }
  }
  return out;
}

function replaceTokens(s: string, id: Identity): string {
  for (const t of id.tokens) s = replaceToken(s, t);
  return s;
}

/** An address without its instance keys, and the keys, decoded: `module.a["x"].b.c[0]` is `module.a.b.c` with `["x", "0"]`. */
export function splitInstanceKeys(address: string): { bare: string; keys: string[] } {
  let bare = "";
  const keys: string[] = [];
  let i = 0;
  while (i < address.length) {
    if (address[i] !== "[") {
      bare += address[i++];
      continue;
    }
    let j = i + 1;
    let quoted = false;
    for (; j < address.length; j++) {
      if (quoted && address[j] === "\\") j++;
      else if (address[j] === '"') quoted = !quoted;
      else if (!quoted && address[j] === "]") break;
    }
    const raw = address.slice(i + 1, Math.min(j, address.length));
    let key = raw;
    if (raw.startsWith('"')) {
      try {
        key = JSON.parse(raw) as string;
      } catch {
        // kept raw
      }
    }
    keys.push(key);
    i = j + 1;
  }
  return { bare, keys };
}

function normalizeAddress(address: string, id: Identity): string {
  const parts = splitInstanceKeys(address).bare.split(".");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "module" && i + 1 < parts.length) {
      parts[i + 1] = replaceTokens(parts[i + 1], id);
      i++;
    } else if (i === parts.length - 1) {
      parts[i] = replaceTokens(parts[i], id);
    }
  }
  return parts.join(".");
}

// choudoufu's marker escaping (internal/live/markers EscapeAddress, markerkey Encode).
const KEY_EXTRAS = "+-=_/@.:";
const legalKeyRune = (r: string): boolean => /^[\p{L}\p{Nd} ]$/u.test(r) || KEY_EXTRAS.includes(r);

function encodeMarkerKey(key: string): string {
  const runes = [...key];
  if (!runes.some((r) => r === "+" || !legalKeyRune(r))) return key;
  return runes.map((r) => (r === "+" ? "++" : legalKeyRune(r) ? r : "+" + r.codePointAt(0)!.toString(16).toUpperCase().padStart(6, "0"))).join("");
}

const escapeMarkerKey = (key: string): string => encodeMarkerKey(key).replaceAll("@", "@@").replaceAll(".", "@d").replaceAll(":", "@c");

/** The value a `tofu-address` marker holds for `address`. */
export function escapeMarkerAddress(address: string): string {
  if (!address.includes("[")) return address;
  const runes = [...address];
  let out = "";
  for (let i = 0; i < runes.length; ) {
    if (runes[i] !== "[") {
      if (runes[i] !== "]" && runes[i] !== '"') out += runes[i];
      i++;
      continue;
    }
    let j = i + 1;
    while (j < runes.length && runes[j] !== "]") j++;
    out += ":" + escapeMarkerKey(runes.slice(i + 1, j).join("").replace(/^"+|"+$/g, ""));
    i = j < runes.length ? j + 1 : j;
  }
  return out;
}

/** A `tofu-address` marker's value with its continuations, or undefined when there is none or the chain has a gap. */
function gatherMarkerAddress(map: Record<string, unknown>): string | undefined {
  const tag = (n: number) => (n === 1 ? TAG_ADDRESS : `${TAG_ADDRESS}-${n}`);
  const str = (k: string) => (typeof map[k] === "string" ? (map[k] as string) : undefined);
  if (str(TAG_ADDRESS) === undefined) return undefined;
  let out = "";
  let n = 1;
  for (; n <= MAX_CONTINUATIONS && str(tag(n)) !== undefined; n++) out += str(tag(n));
  for (let m = n + 1; m <= MAX_CONTINUATIONS; m++) if (str(tag(m)) !== undefined) return undefined;
  return out;
}

const isAddressKey = (k: string): boolean => k === TAG_ADDRESS || /^tofu-address-\d+$/.test(k);

function normalizeValue(v: unknown, id: Identity, ownAddress: string): unknown {
  if (typeof v === "string") return replaceTokens(v, id);
  if (Array.isArray(v)) return v.map((e) => normalizeValue(e, id, ownAddress));
  if (v === null || typeof v !== "object") return v;
  const map = v as Record<string, unknown>;
  const own = escapeMarkerAddress(ownAddress);
  const addressIsOwn = gatherMarkerAddress(map) === own;
  const out: Record<string, unknown> = {};
  for (const [k, e] of Object.entries(map)) {
    if (typeof e === "string" && k === TAG_ESTATE && id.estate !== undefined && e === id.estate) out[k] = ESTATE;
    else if (typeof e === "string" && addressIsOwn && isAddressKey(k)) out[k] = ADDRESS;
    else if (typeof e === "string" && k === ADDRESS_ANNOTATION && e === own) out[k] = ADDRESS;
    else out[k] = normalizeValue(e, id, ownAddress);
  }
  return out;
}

const SYMBOL: Record<ChangeSetAction, string> = { create: "+", update: "~", replace: "-/+", delete: "-", read: "<=", "no-op": "", forget: "forget" };

/** One entry with everything unit-specific stripped. `key` is what grouping compares. */
interface Normalized {
  key: string;
  line: string;
  action: ChangeSetAction;
  address: string;
  /** Each attribute's canonical form, for naming what two changes differ in. */
  attrs: Map<string, string>;
}

function normalizeAttribute(a: ChangeSetAttribute, id: Identity, ownAddress: string): Record<string, unknown> {
  if (a.sensitive) return { sensitive: true, ...(a.forcesReplacement ? { forcesReplacement: true } : {}) };
  return {
    ...(a.before !== undefined && a.before !== null ? { before: normalizeValue(a.before, id, ownAddress) } : {}),
    ...(a.unknown ? { after: UNKNOWN } : a.after !== undefined && a.after !== null ? { after: normalizeValue(a.after, id, ownAddress) } : {}),
    ...(a.forcesReplacement ? { forcesReplacement: true } : {}),
  };
}

function normalizeEntry(e: ChangeSetEntry, id: Identity): Normalized | undefined {
  if (e.action === "no-op" && !e.importing) return undefined;
  const address = normalizeAddress(e.address, id) + (e.deposed !== undefined ? " (deposed)" : "");
  const attrs = new Map<string, string>();
  const body: Record<string, unknown> = {};
  if (e.action !== "delete" && e.action !== "forget") {
    for (const a of [...e.attributes].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))) {
      body[a.path] = normalizeAttribute(a, id, e.address);
      attrs.set(a.path, JSON.stringify(body[a.path]));
    }
  }
  const key = canonical({ type: e.type, action: e.action, address, attrs: body, ...(e.importing ? { importing: true } : {}) });
  const names = [...attrs.keys()];
  let line = `${SYMBOL[e.action] || "import"} ${address}`;
  if (e.importing && e.action !== "no-op") line += " (import)";
  if (names.length > 0 && e.action !== "create" && e.action !== "read") line += `: ${names.join(", ")}`;
  return { key, line, action: e.action, address, attrs };
}

/** Key-sorted JSON, so two equal values give one string. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// ── grouping ─────────────────────────────────────────────────────────────────

interface Unit {
  name: string;
  family: string;
  changes: Normalized[];
  destroys: PlanSummaryDestroy[];
  /** Normalized triggered actions, as canonical strings. */
  effects: string[];
  sideEffects: PlanSummarySideEffect[];
}

interface Line extends PlanSummaryChange {
  key: string;
  norm: Normalized;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function destroyOf(e: ChangeSetEntry): PlanSummaryDestroy | undefined {
  if (e.action !== "delete" && e.action !== "replace") return undefined;
  return { member: e.member, address: e.address, type: e.type, action: e.action, ...(e.deposed !== undefined ? { deposed: e.deposed } : {}) };
}

function effectKey(se: PlanSummarySideEffect, id: Identity): string {
  return canonical({ type: se.type, trigger: se.trigger === undefined ? null : normalizeAddress(se.trigger, id), event: se.event ?? null });
}

function lastSegment(name: string): string {
  const parts = name.replaceAll("\\", "/").split("/").filter((p) => p !== "" && p !== ".");
  return parts[parts.length - 1] ?? "";
}

function memberUnits(doc: ChangeSetDocument, failed: Set<string>): Unit[] {
  const byMember = new Map<string, ChangeSetEntry[]>();
  for (const e of doc.entries) {
    const list = byMember.get(e.member);
    if (list) list.push(e);
    else byMember.set(e.member, [e]);
  }
  const units: Unit[] = [];
  for (const m of doc.members) {
    if (failed.has(m.member)) continue;
    const base = lastSegment(m.member);
    const id = identity(m.scope, [], base && base !== m.scope ? [base] : []);
    const unit: Unit = { name: m.member, family: "", changes: [], destroys: [], effects: [], sideEffects: [] };
    for (const se of doc.sideEffects ?? []) {
      if (se.member !== m.member) continue;
      unit.effects.push(effectKey(se, id));
      unit.sideEffects.push(se);
    }
    for (const e of byMember.get(m.member) ?? []) {
      const n = normalizeEntry(e, id);
      if (!n) continue;
      unit.changes.push(n);
      const d = destroyOf(e);
      if (d) unit.destroys.push(d);
    }
    units.push(unit);
  }
  return units;
}

function instanceUnits(doc: ChangeSetDocument, failed: Set<string>): Unit[] {
  const units: Unit[] = [];
  for (const e of doc.entries) {
    if (failed.has(e.member)) continue;
    const { bare, keys } = splitInstanceKeys(e.address);
    const id = identity(undefined, keys, []);
    const n = normalizeEntry(e, id);
    if (!n) continue;
    const d = destroyOf(e);
    const name = e.deposed !== undefined ? `${e.address} (deposed ${e.deposed})` : e.address;
    const own = (doc.sideEffects ?? []).filter((se) => se.member === e.member && se.trigger === e.address);
    units.push({ name, family: bare, changes: [n], destroys: d ? [d] : [], effects: own.map((se) => effectKey(se, id)), sideEffects: own });
  }
  return units;
}

function changeLines(changes: Normalized[]): Line[] {
  const byKey = new Map<string, Line>();
  for (const c of changes) {
    const l = byKey.get(c.key);
    if (l) l.count++;
    else byKey.set(c.key, { line: c.line, action: c.action, count: 1, key: c.key, norm: c });
  }
  return [...byKey.values()].sort((a, b) => byString(a.line, b.line) || byString(a.key, b.key));
}

/** What `have` holds beyond `base`, when it holds all of `base`. */
function extraLines(base: Line[], have: Line[]): Line[] | undefined {
  const need = new Map(base.map((l) => [l.key, l.count]));
  const plus: Line[] = [];
  for (const l of have) {
    const n = need.get(l.key) ?? 0;
    if (n === 0) plus.push(l);
    else if (l.count > n) plus.push({ ...l, count: l.count - n });
    need.delete(l.key);
  }
  return [...need.values()].some((n) => n > 0) ? undefined : plus;
}

function markDifference(l: Line, base: { id: string; lines: Line[] }): void {
  if (base.lines.some((b) => b.key === l.key)) return;
  const b = base.lines.find((x) => x.norm.address === l.norm.address && x.norm.action === l.norm.action);
  if (!b) return;
  const names = new Set<string>();
  for (const [k, v] of l.norm.attrs) if (b.norm.attrs.get(k) !== v) names.add(k);
  for (const k of b.norm.attrs.keys()) if (!l.norm.attrs.has(k)) names.add(k);
  l.differsFrom = base.id;
  l.differsIn = [...names].sort();
}

const publicLine = (l: Line): PlanSummaryChange => ({
  line: l.line,
  action: l.action,
  count: l.count,
  ...(l.differsFrom !== undefined ? { differsFrom: l.differsFrom, differsIn: l.differsIn ?? [] } : {}),
});

function groupUnits(units: Unit[], perFamily: boolean): PlanSummaryGroup[] {
  interface Acc {
    id: string;
    family: string;
    units: string[];
    destroys: PlanSummaryDestroy[];
    sideEffects: PlanSummarySideEffect[];
    lines: Line[];
    noChanges: boolean;
  }
  const byId = new Map<string, Acc>();
  for (const u of units) {
    const keys = u.changes.map((c) => c.key).sort(byString);
    const effects = [...u.effects].sort(byString);
    const id = computePlanDigest("plan-summary-group", { resource: u.family, changes: keys, ...(effects.length > 0 ? { effects } : {}) }).slice(PLAN_DIGEST_PREFIX.length, PLAN_DIGEST_PREFIX.length + 12);
    let acc = byId.get(id);
    if (!acc) {
      acc = { id, family: u.family, units: [], destroys: [], sideEffects: [], lines: changeLines(u.changes), noChanges: u.changes.length === 0 && u.effects.length === 0 };
      byId.set(id, acc);
    }
    acc.units.push(u.name);
    acc.destroys.push(...u.destroys);
    acc.sideEffects.push(...u.sideEffects);
  }
  const accs = [...byId.values()];
  for (const a of accs) a.units.sort(byString);
  accs.sort((a, b) => (perFamily && a.family !== b.family ? byString(a.family, b.family) : 0) || b.units.length - a.units.length || byString(a.units[0], b.units[0]));

  // A family's baseline is its largest group that changes anything; the others are described against it.
  const baseline = new Map<string, Acc>();
  const familySize = new Map<string, number>();
  for (const a of accs) {
    familySize.set(a.family, (familySize.get(a.family) ?? 0) + 1);
    if (!baseline.has(a.family) && !a.noChanges) baseline.set(a.family, a);
  }
  return accs.map((a) => {
    const base = baseline.get(a.family);
    let plus: Line[] | undefined;
    if (base && base !== a && !a.noChanges) {
      const extra = extraLines(base.lines, a.lines);
      if (extra && extra.length > 0) plus = extra;
      for (const l of a.lines) markDifference(l, base);
      for (const l of plus ?? []) markDifference(l, base);
    }
    return {
      id: a.id,
      ...(a.family ? { resource: a.family } : {}),
      units: a.units,
      outlier: a.units.length === 1 && (familySize.get(a.family) ?? 0) > 1,
      noChanges: a.noChanges,
      changes: a.lines.map(publicLine),
      ...(plus && base ? { extends: base.id, plus: plus.map(publicLine) } : {}),
      destroys: a.destroys.sort(byDestroy),
      sideEffects: a.sideEffects.sort(bySideEffect),
    };
  });
}

const byDestroy = (a: PlanSummaryDestroy, b: PlanSummaryDestroy): number =>
  byString(a.member, b.member) || byString(a.address, b.address) || byString(a.deposed ?? "", b.deposed ?? "");

const bySideEffect = (a: PlanSummarySideEffect, b: PlanSummarySideEffect): number =>
  byString(a.member, b.member) || byString(a.address, b.address) || byString(a.trigger ?? "", b.trigger ?? "");

const byEntry = (a: { member: string; address: string; deposed?: string }, b: { member: string; address: string; deposed?: string }): number =>
  byString(a.member, b.member) || byString(a.address, b.address) || byString(a.deposed ?? "", b.deposed ?? "");

function failureReason(m: ChangeSetMember): string {
  return m.error ?? "the member failed to plan";
}

/**
 * Group a change-set document's units by their normalized changes. Failed
 * members are listed with their reasons and never grouped. Every delete and
 * replace the document holds is in `destroys`, and each also in its unit's
 * group; every hole is in `holes`.
 */
export function groupChangeSet(doc: ChangeSetDocument, options: GroupChangeSetOptions = {}): PlanSummary {
  const unit = options.unit ?? (doc.members.length === 1 ? "instance" : "member");
  const failedMembers = doc.members.filter((m) => m.status === "failed");
  const failed = new Set(failedMembers.map((m) => m.member));
  const units = unit === "member" ? memberUnits(doc, failed) : instanceUnits(doc, failed);
  const destroys = doc.entries.map(destroyOf).filter((d): d is PlanSummaryDestroy => d !== undefined).sort(byDestroy);
  const holes = doc.members.flatMap((m) => m.holes.map((h) => ({ member: m.member, address: h.address, ...(h.type ? { type: h.type } : {}), reason: h.reason })));
  return {
    $schema: PLAN_SUMMARY_SCHEMA_ID,
    contract: PLAN_SUMMARY_CONTRACT,
    changeSet: doc.digest,
    unit,
    units: unit === "member" ? doc.members.length : units.length,
    groups: groupUnits(units, unit === "instance"),
    failed: failedMembers.map((m) => ({ member: m.member, ...(m.scope ? { scope: m.scope } : {}), reason: failureReason(m) })),
    destroys,
    imports: doc.entries
      .filter((e) => e.importing)
      .map((e) => ({ member: e.member, address: e.address, type: e.type, action: e.action }))
      .sort(byEntry),
    forgets: doc.entries
      .filter((e) => e.action === "forget")
      .map((e) => ({ member: e.member, address: e.address, type: e.type, ...(e.deposed !== undefined ? { deposed: e.deposed } : {}) }))
      .sort(byEntry),
    sideEffects: [...(doc.sideEffects ?? [])].sort(bySideEffect),
    holes,
  };
}

// ── rendering ────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function unitWord(s: PlanSummary, n: number): string {
  return s.unit === "instance" ? plural(n, "instance", "instances") : plural(n, "member", "members");
}

/** The first line: units, groups, failures, destroys and holes. */
export function planSummaryHeadline(s: PlanSummary): string {
  const parts = [plural(s.groups.length, "group", "groups")];
  if (s.failed.length > 0) parts.push(`${s.failed.length} failed`);
  parts.push(plural(s.destroys.length, "destroy or replacement", "destroys or replacements"));
  if (s.forgets.length > 0) parts.push(plural(s.forgets.length, "forget", "forgets"));
  if (s.imports.length > 0) parts.push(plural(s.imports.length, "import", "imports"));
  if (s.sideEffects.length > 0) parts.push(plural(s.sideEffects.length, "triggered action", "triggered actions"));
  if (s.holes.length > 0) parts.push(plural(s.holes.length, "hole", "holes"));
  return `${unitWord(s, s.units)}: ${parts.join(", ")}.`;
}

function groupTitle(s: PlanSummary, g: PlanSummaryGroup): string {
  let t = `Group ${g.id}: ${unitWord(s, g.units.length)}`;
  if (g.resource) t += ` of ${g.resource}`;
  if (g.outlier) t += " (outlier)";
  if (g.noChanges) t += ", no changes";
  else if (g.extends) t += `, group ${g.extends}'s change plus`;
  else if (g.units.length > 1) t += ", identical change";
  else t += ", change";
  return t;
}

function changeText(l: PlanSummaryChange): string {
  let t = l.count > 1 ? `${l.line} (x${l.count})` : l.line;
  if (l.differsFrom) t += l.differsIn && l.differsIn.length > 0 ? `  [differs from group ${l.differsFrom} in: ${l.differsIn.join(", ")}]` : `  [differs from group ${l.differsFrom}]`;
  return t;
}

const shownChanges = (g: PlanSummaryGroup): PlanSummaryChange[] => (g.extends ? (g.plus ?? []) : g.changes);

function destroyText(d: PlanSummaryDestroy): string {
  return `${d.member}: ${d.address}${d.deposed !== undefined ? ` (deposed ${d.deposed})` : ""} (${d.action})`;
}

const forgetText = (f: PlanSummaryForget): string => `${f.member}: ${f.address}${f.deposed !== undefined ? ` (deposed ${f.deposed})` : ""} (forget, the object keeps running)`;
const importText = (i: PlanSummaryImport): string => `${i.member}: ${i.address} (${i.action === "no-op" ? "import, no other change" : `import, then ${i.action}`})`;
const sideEffectText = (e: PlanSummarySideEffect): string =>
  `${e.member}: ${e.address}${e.trigger !== undefined ? `, triggered by ${e.trigger}${e.event !== undefined ? ` ${e.event}` : ""}` : ""}`;

const oneLine = (s: string): string => s.split(/\s+/).filter(Boolean).join(" ");

const failureLabel = (f: PlanSummaryFailure): string => (f.scope && f.scope !== f.member ? `${f.member} (${f.scope})` : f.member);

/** The summary for a terminal. Destroys, failures and holes come first, then every group. */
export function renderPlanSummaryText(s: PlanSummary): string {
  const out: string[] = [planSummaryHeadline(s)];
  if (s.destroys.length > 0) {
    out.push("", `Destroys and replacements (${s.destroys.length}):`);
    for (const d of s.destroys) out.push(`  ${destroyText(d)}`);
  }
  if (s.forgets.length > 0) {
    out.push("", `Forgets (${s.forgets.length}), no longer tracked, not destroyed:`);
    for (const f of s.forgets) out.push(`  ${forgetText(f)}`);
  }
  if (s.imports.length > 0) {
    out.push("", `Imports (${s.imports.length}):`);
    for (const i of s.imports) out.push(`  ${importText(i)}`);
  }
  if (s.sideEffects.length > 0) {
    out.push("", `Triggered actions (${s.sideEffects.length}), side effects of apply:`);
    for (const e of s.sideEffects) out.push(`  ${sideEffectText(e)}`);
  }
  if (s.failed.length > 0) {
    out.push("", `Failed (${s.failed.length}), not grouped:`);
    for (const f of s.failed) out.push(`  ${failureLabel(f)}: ${oneLine(f.reason)}`);
  }
  if (s.holes.length > 0) {
    out.push("", `Holes (${s.holes.length}), addresses the plan says nothing about:`);
    for (const h of s.holes) out.push(`  ${h.member}: ${h.address}: ${oneLine(h.reason)}`);
  }
  for (const g of s.groups) {
    out.push("", `${groupTitle(s, g)}:`);
    for (const l of shownChanges(g)) out.push(`    ${changeText(l)}`);
    out.push(`  ${s.unit === "instance" ? "instances" : "members"}: ${g.units.join(", ")}`);
    if (g.destroys.length > 0) out.push(`  destroys and replacements: ${g.destroys.length}, listed above`);
    if (g.sideEffects.length > 0) out.push(`  triggered actions: ${g.sideEffects.length}, listed above`);
  }
  return out.join("\n") + "\n";
}

export interface RenderMarkdownOptions {
  /** The most characters (code points) the note may hold. Default {@link GITHUB_COMMENT_LIMIT}. */
  limit?: number;
  /** The command that prints the whole summary, named when the note is cut. */
  command?: string;
}

const codePoints = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

const code = (s: string): string => "`" + s.replaceAll("`", "'") + "`";

/**
 * The summary as an MR or PR note of at most `limit` characters.
 *
 * Blocks come in a fixed order: the headline, every destroy and
 * replacement, every forget, import and triggered action, every failed member, every hole, then the groups largest
 * first. When the whole does not fit, groups are dropped from the end, never
 * cut in the middle, and a closing line names how many groups, units and
 * destroys it left out. The destroy, failure and hole lines are cut only
 * when they alone exceed the limit, from the end, and the closing line
 * counts those too.
 */
export function renderPlanSummaryMarkdown(s: PlanSummary, options: RenderMarkdownOptions = {}): string {
  const limit = options.limit ?? GITHUB_COMMENT_LIMIT;
  const command = options.command ?? "chant change-set summary";
  const header = `### Plan summary\n\n${planSummaryHeadline(s)}\n`;

  interface Block {
    text: string;
    kind: "destroy" | "forget" | "import" | "effect" | "failed" | "hole" | "group";
    units: number;
  }
  const blocks: Block[] = [];
  if (s.destroys.length > 0) blocks.push({ kind: "destroy", units: 0, text: `\n**Destroys and replacements (${s.destroys.length}):**\n\n` });
  for (const d of s.destroys) blocks.push({ kind: "destroy", units: 1, text: `- ${code(destroyText(d))}\n` });
  if (s.forgets.length > 0) blocks.push({ kind: "forget", units: 0, text: `\n**Forgets (${s.forgets.length}), no longer tracked, not destroyed:**\n\n` });
  for (const f of s.forgets) blocks.push({ kind: "forget", units: 1, text: `- ${code(forgetText(f))}\n` });
  if (s.imports.length > 0) blocks.push({ kind: "import", units: 0, text: `\n**Imports (${s.imports.length}):**\n\n` });
  for (const i of s.imports) blocks.push({ kind: "import", units: 1, text: `- ${code(importText(i))}\n` });
  if (s.sideEffects.length > 0) blocks.push({ kind: "effect", units: 0, text: `\n**Triggered actions (${s.sideEffects.length}), side effects of apply:**\n\n` });
  for (const e of s.sideEffects) blocks.push({ kind: "effect", units: 1, text: `- ${code(sideEffectText(e))}\n` });
  if (s.failed.length > 0) blocks.push({ kind: "failed", units: 0, text: `\n**Failed (${s.failed.length}), not grouped:**\n\n` });
  for (const f of s.failed) blocks.push({ kind: "failed", units: 1, text: `- ${code(failureLabel(f))}: ${oneLine(f.reason)}\n` });
  if (s.holes.length > 0) blocks.push({ kind: "hole", units: 0, text: `\n**Holes (${s.holes.length}), addresses the plan says nothing about:**\n\n` });
  for (const h of s.holes) blocks.push({ kind: "hole", units: 1, text: `- ${code(`${h.member}: ${h.address}`)}: ${oneLine(h.reason)}\n` });
  for (const g of s.groups) {
    let t = `\n#### ${groupTitle(s, g)}\n\n`;
    const lines = shownChanges(g);
    if (lines.length > 0) t += "```\n" + lines.map(changeText).join("\n") + "\n```\n\n";
    t += `${s.unit === "instance" ? "Instances" : "Members"}: ${g.units.map(code).join(", ")}\n`;
    if (g.destroys.length > 0) t += `\nDestroys and replacements: ${g.destroys.length}, listed above.\n`;
    if (g.sideEffects.length > 0) t += `\nTriggered actions: ${g.sideEffects.length}, listed above.\n`;
    blocks.push({ kind: "group", units: g.units.length, text: t });
  }

  const lengths = blocks.map((b) => codePoints(b.text));
  const total = codePoints(header) + lengths.reduce((a, b) => a + b, 0);
  if (total <= limit) return header + blocks.map((b) => b.text).join("");

  const notice = (kept: number): string => {
    const cut = blocks.slice(kept);
    const count = (k: Block["kind"]) => cut.filter((b) => b.kind === k && (k === "group" || b.units > 0)).length;
    const parts: string[] = [];
    if (count("destroy") > 0) parts.push(plural(count("destroy"), "destroy or replacement", "destroys or replacements"));
    if (count("forget") > 0) parts.push(plural(count("forget"), "forget", "forgets"));
    if (count("import") > 0) parts.push(plural(count("import"), "import", "imports"));
    if (count("effect") > 0) parts.push(plural(count("effect"), "triggered action", "triggered actions"));
    if (count("failed") > 0) parts.push(plural(count("failed"), "failed member", "failed members"));
    if (count("hole") > 0) parts.push(plural(count("hole"), "hole", "holes"));
    const groups = cut.filter((b) => b.kind === "group");
    if (groups.length > 0) parts.push(`${plural(groups.length, "group", "groups")} (${unitWord(s, groups.reduce((n, b) => n + b.units, 0))})`);
    return `\n**Truncated:** this note leaves out ${parts.join(", ")} to stay within ${limit} characters. \`${command}\` prints all of it.\n`;
  };
  let kept = blocks.length;
  let used = total;
  while (kept > 0 && used + codePoints(notice(kept)) > limit) {
    kept--;
    used -= lengths[kept];
  }
  return header + blocks.slice(0, kept).map((b) => b.text).join("") + notice(kept);
}
