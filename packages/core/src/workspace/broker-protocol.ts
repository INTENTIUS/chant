/**
 * The broker protocol for box capabilities, version 1 (#3164, ws-097).
 *
 * A box holds no credential (#2726). Each capability its box block declares,
 * `{ name, broker, scope }`, is reached through a broker: a runtime that
 * holds the credential, swaps the box's own token for it, and refuses what
 * the box's declaration does not allow. chant never runs a broker (ws-052,
 * ws-086). It specifies one here, so studio's lobby, fountain's broker or a
 * self-hosted one serve the same box without the box changing its
 * declaration, and `runBrokerConformance` in
 * `@intentius/chant/workspace/conformance` checks an implementation.
 *
 * Every route is relative to the broker's base URL, and every request
 * carries the box's own token: `Authorization: Bearer <token>`, or for
 * inference `x-api-key: <token>` as the Anthropic SDK sends it, or for egress
 * wherever the API expects its key. How a box gets its token (studio's
 * door claiming it, fountain's sandbox callback token) is the broker's own.
 *
 * | Route | Capability, scope word | Does |
 * |---|---|---|
 * | `POST /api/box/declaration` | none | the box's steward reports its block's capabilities (`declarationReport`) |
 * | `/llm/anthropic/...` | `inference`, `agent` | the Anthropic API, with the payer's credential in place of the box's token |
 * | `POST /decide/v1/systemone` | `inference`, `decide` | chant's decide wire format (op/decide-backend.ts), answers with `reason` (#3345) |
 * | `/egress/<NAME>/...` | `egress`, `<NAME>` | the secret's one host, with the secret's value in place of the box's token |
 * | `POST /api/feedback` | `feedback`, `agent` for `entries` and `passive` for `counts` | the box's agents' feedback (studio#257) |
 * | `/fountain/api/...` | `fountain`, `agent`, `conversations`, `sandboxes`, `vault` | Fountain's API, with the operator's Fountain key |
 *
 * A broker may say whose credential pays (#3474, ws-098): `payer` on the
 * declaration's answer and the `chant-payer` header on each inference and
 * decide answer ({@link BrokerPayer}). It is optional within version 1.
 * A box names whose turn a request is with a `chant-grant` header the broker
 * issued (#3477, ws-099); the broker then may spend that person's credential.
 * A report may carry the box's listing and this month's spend from its run
 * records (#3508, ws-102), {@link BoxListing} and {@link BoxSpend}; both are
 * optional within version 1, and a broker that has no use for them ignores
 * them.
 *
 * The rule every broker keeps: a request that needs scope word `w` of
 * capability `c` is refused with a 403 unless the box's last report holds an
 * entry named `c`, brokered by this broker, whose scope lists `w`. A box that
 * has never reported is refused. The refusal's message names `c` and `w`, so
 * whoever reads it knows which entry to add. The box's token never reaches
 * an upstream, and the credential or secret never comes back to the box.
 *
 * The `broker` word in a box block names the broker the box reaches, not an
 * implementation: an implementation is configured with the word it answers
 * for (`lobby` for studio's), so a box moves between implementations by
 * where its broker URL points.
 *
 * A capability a lexicon or a runtime adds is a {@link BrokerCapabilitySpec}:
 * its own route prefix, and a function from a request to the scope words it
 * needs. `runBrokerConformance` takes extra specs and holds them to the same
 * rule.
 */

/** The protocol's version, carried by the schema's `$id`. */
export const BROKER_PROTOCOL_VERSION = 1;

/** The bodies' schema, beside this module. */
export const BROKER_PROTOCOL_SCHEMA = "broker-protocol.schema.json";

/** The routes, relative to the broker's base URL. */
export const BROKER_ROUTES = {
  declaration: "/api/box/declaration",
  inference: "/llm/anthropic",
  decide: "/decide/v1/systemone",
  egress: "/egress",
  feedback: "/api/feedback",
  fountain: "/fountain",
} as const;

/** What the Anthropic API proxy forwards, under {@link BROKER_ROUTES.inference}. Anything else is a 404. */
export const INFERENCE_FORWARDED = [
  { method: "POST", path: /^\/v1\/messages(\/count_tokens)?$/ },
  { method: "GET", path: /^\/v1\/models(\/[\w.-]+)?$/ },
] as const;

/** A secret's name in an egress path, and so a word of the `egress` scope. */
export const EGRESS_SECRET_NAME = /^[A-Z][A-Z0-9_]{0,39}$/;

/** The limits on a declaration report. */
export const DECLARATION_LIMITS = { bytes: 32 * 1024, capabilities: 20, scopeWords: 50, wordLength: 64 } as const;

/** A capability's name, as the declaration's kind-name grammar and the lobby both allow it. */
export const CAPABILITY_NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** A request as a broker sees it, for {@link BrokerCapabilitySpec.scopes}. */
export interface BrokerRequest {
  method: string;
  /** The path from the broker's base URL, without the query. */
  path: string;
  /** The parsed JSON body, when the route reads one. */
  body?: unknown;
}

/**
 * One capability's broker side: the route prefixes it owns, the scope words
 * it knows, and the words a request needs.
 */
export interface BrokerCapabilitySpec {
  name: string;
  /** Path prefixes, from the broker's base URL, this capability owns. */
  routes: readonly string[];
  /** The scope words and what each lets the box reach. `"<NAME>"` stands for an open set, such as egress's secret names. */
  scopeWords: Readonly<Record<string, string>>;
  /**
   * The scope words `request` needs, all of them; `[]` when it needs none
   * (inference's `/api/hello`); null when the request is not this
   * capability's, or names nothing the capability serves (a 404).
   */
  scopes(request: BrokerRequest): string[] | null;
}

const under = (path: string, prefix: string): string | null => (path === prefix ? "/" : path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : null);

/** `inference`: the model proxy (`agent`) and the decide endpoint (`decide`). */
export const INFERENCE_CAPABILITY: BrokerCapabilitySpec = {
  name: "inference",
  routes: [BROKER_ROUTES.inference, "/decide"],
  scopeWords: {
    agent: "the box's agent calls the model through /llm/anthropic",
    decide: "the box's decision points are answered at /decide/v1/systemone",
  },
  scopes({ method, path }) {
    const rest = under(path, BROKER_ROUTES.inference);
    if (rest !== null) {
      if (rest === "/api/hello" && (method === "HEAD" || method === "GET")) return [];
      return INFERENCE_FORWARDED.some((r) => r.method === method && r.path.test(rest)) ? ["agent"] : null;
    }
    if (path === BROKER_ROUTES.decide && method === "POST") return ["decide"];
    return null;
  },
};

/** `egress`: a secret the broker holds, used against its one host, by name. */
export const EGRESS_CAPABILITY: BrokerCapabilitySpec = {
  name: "egress",
  routes: [BROKER_ROUTES.egress],
  scopeWords: { "<NAME>": "the secret NAME, sent only to the host its owner chose, at /egress/NAME/..." },
  scopes({ path }) {
    const rest = under(path, BROKER_ROUTES.egress);
    if (rest === null) return null;
    const name = rest.split("/")[1] ?? "";
    return EGRESS_SECRET_NAME.test(name) ? [name] : null;
  },
};

/** The scope words a feedback batch needs: `agent` for entries, `passive` for counts. */
export function feedbackScopes(body: unknown): string[] {
  const b = (body ?? {}) as { entries?: unknown; counts?: unknown };
  const words: string[] = [];
  if (Array.isArray(b.entries) && b.entries.length > 0) words.push("agent");
  if (b.counts !== null && typeof b.counts === "object" && !Array.isArray(b.counts) && Object.keys(b.counts).length > 0) words.push("passive");
  return words;
}

/** `feedback`: the box's agents' feedback (studio#257, hud RFC-009). */
export const FEEDBACK_CAPABILITY: BrokerCapabilitySpec = {
  name: "feedback",
  routes: [BROKER_ROUTES.feedback],
  scopeWords: {
    agent: "the batch carries entries the box's agents wrote",
    passive: "the batch carries counts of refusals, errors and restarts",
  },
  scopes({ method, path, body }) {
    if (path !== BROKER_ROUTES.feedback || method !== "POST") return null;
    return feedbackScopes(body);
  },
};

/** `fountain`: Fountain's API, on the operator's key, for the box's own conversations, sandboxes and vault. */
export const FOUNTAIN_CAPABILITY: BrokerCapabilitySpec = {
  name: "fountain",
  routes: [BROKER_ROUTES.fountain],
  scopeWords: {
    agent: "start a conversation with the box's own agent (POST /fountain/api/conversations)",
    conversations: "read and continue the box's own conversations (/fountain/api/conversations/...)",
    sandboxes: "the box's own sandboxes (/fountain/api/sandboxes/...)",
    vault: "the box's own vault (/fountain/api/vaults/...)",
  },
  scopes({ method, path }) {
    const rest = under(path, BROKER_ROUTES.fountain);
    if (rest === null) return null;
    const family = /^\/api\/(conversations|sandboxes|vaults)(\/|$)/.exec(rest)?.[1];
    if (family === "conversations") return method === "POST" && rest === "/api/conversations" ? ["agent"] : ["conversations"];
    if (family === "sandboxes") return ["sandboxes"];
    if (family === "vaults") return ["vault"];
    return null;
  },
};

/** The standard capabilities, by name. */
export const STANDARD_CAPABILITIES: Readonly<Record<string, BrokerCapabilitySpec>> = {
  inference: INFERENCE_CAPABILITY,
  egress: EGRESS_CAPABILITY,
  feedback: FEEDBACK_CAPABILITY,
  fountain: FOUNTAIN_CAPABILITY,
};

/** A capability as a broker keeps it from a report. */
export interface KeptCapability {
  name: string;
  broker: string;
  scope: string[];
}

/**
 * Whose credential pays for a box's model calls (#3474, ws-098): `shared`, a
 * credential neither the box's owner nor its visitor owns (a house or
 * operator key); `owner`, the box owner's own; `visitor`, the credential a
 * person brought for this box. `principal` is the payer in ws-080's form
 * (`github:<login>`) when the broker knows them. A broker that does not say
 * leaves it out, and a box reads that as unknown.
 */
export interface BrokerPayer {
  kind: "shared" | "owner" | "visitor";
  principal?: string | null;
}

/** The payer kinds, in the protocol's order. */
export const PAYER_KINDS = ["shared", "owner", "visitor"] as const;

/** The response header that carries the payer on each answer from `/llm/anthropic` and `/decide`: `<kind>` or `<kind> <principal>`. */
export const PAYER_HEADER = "chant-payer";

/**
 * The request header a box sends on an inference or decide request made on a
 * person's turn (#3477, ws-099): a grant the broker itself issued to that
 * person for this box, which the person's browser carried to the box's
 * surface. Opaque to chant and to the box. The broker checks its own grant
 * (issued by it, for the box whose token the request carries, not expired or
 * revoked, the person still holding a credential), spends the person's
 * credential, and answers `chant-payer: visitor <principal>`. A grant it does
 * not accept is ignored, not refused: the request is paid as it would have
 * been without one, and the payer header says so.
 */
export const GRANT_HEADER = "chant-grant";

/** The longest grant a box sends, in characters; a broker may refuse a longer header as malformed. */
export const GRANT_MAX_LENGTH = 2048;

/** Whether `value` is a grant a box may send: printable ASCII without spaces, at most {@link GRANT_MAX_LENGTH} long. */
export function isGrantValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= GRANT_MAX_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

/** A payer as the header carries it. */
export function formatPayerHeader(payer: BrokerPayer): string {
  return payer.principal ? `${payer.kind} ${payer.principal}` : payer.kind;
}

/** The payer a `chant-payer` header value names, or undefined when it names none the protocol knows. */
export function parsePayerHeader(value: string | null | undefined): BrokerPayer | undefined {
  const m = /^\s*(shared|owner|visitor)(?:\s+(\S{1,200}))?\s*$/.exec(value ?? "");
  if (!m) return undefined;
  return { kind: m[1] as BrokerPayer["kind"], principal: m[2] ?? null };
}

/** The payer in a `declarationKept` answer (or any object with a `payer` field), or undefined when it has none or a malformed one. */
export function payerOf(body: unknown): BrokerPayer | undefined {
  const payer = (body as { payer?: unknown } | null)?.payer as { kind?: unknown; principal?: unknown } | undefined;
  if (!payer || typeof payer !== "object" || !PAYER_KINDS.includes(payer.kind as BrokerPayer["kind"])) return undefined;
  const principal = payer.principal;
  if (principal !== undefined && principal !== null && (typeof principal !== "string" || !/^\S{1,200}$/.test(principal))) return undefined;
  return { kind: payer.kind as BrokerPayer["kind"], principal: (principal as string | null | undefined) ?? null };
}

/** What a broker keeps of a box's last report, and, when it says, who pays (#3474). */
export interface KeptDeclaration {
  capabilities: KeptCapability[];
  at: string;
  payer?: BrokerPayer;
  /** The report's listing, when the broker keeps it (#3508). */
  listing?: BoxListing;
  /** The report's spend, when the broker keeps it (#3508). */
  spend?: BoxSpend;
}

/**
 * The box block's listing (ws-077) as a report carries it (#3508, ws-102):
 * what `chant workspace status --json` prints under the box member's
 * `box.listing`, less the cover. A broker that lists boxes lists the box
 * under it; the repository keeps it, and the broker only a cache.
 */
export interface BoxListing {
  /** Whether people other than the owner see the box listed. Absent in a report means true. */
  published: boolean;
  title: string;
  line: string;
}

/** The bounds on a reported listing: the ones `chant workspace box listing set` writes with. */
export const LISTING_LIMITS = { title: 60, line: 140 } as const;

/** One principal's share of a month's spend, or the month's totals without `principal`. */
export interface SpendFigures {
  /** The sum of the priced runs' USD costs, rounded to 1/10000 of a dollar. */
  usd: number;
  runs: number;
  /** Runs with no USD cost: left out of `usd`, never counted as zero. */
  unpriced: number;
}

/**
 * What the box's run records (ws-076) say it spent in one month (#3508,
 * ws-102), as a report carries it: the month's totals and the same per
 * principal the runs worked for. {@link spendFromRuns} computes it.
 */
export interface BoxSpend extends SpendFigures {
  /** `YYYY-MM`, in UTC, matched against each run's `startedAt`. */
  month: string;
  /** At most {@link SPEND_LIMITS.principals}, in the order the runs first name them; `principal` null for runs that name none. */
  byPrincipal: (SpendFigures & { principal: string | null })[];
}

/** The bounds on a reported spend. */
export const SPEND_LIMITS = { principals: 50, principalLength: 200, figure: 1e9 } as const;

const SPEND_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const roundUsd = (usd: number) => Math.round(usd * 1e4) / 1e4;

/**
 * A box's spend in `month` (`YYYY-MM`) from the runs `chant workspace runs
 * --json` prints (`doc.runs`): every run whose `startedAt` falls in the
 * month, summed per the principal in its `by`. Only a USD `cost` is summed; a
 * run with none, or with another currency, is unpriced. Null when `doc` holds
 * no runs list.
 */
export function spendFromRuns(doc: unknown, month: string): BoxSpend | null {
  const runs = (doc as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(runs)) return null;
  const total: SpendFigures = { usd: 0, runs: 0, unpriced: 0 };
  const people = new Map<string | null, SpendFigures & { principal: string | null }>();
  for (const r of runs as { startedAt?: unknown; by?: unknown; cost?: { currency?: unknown; amount?: unknown } | null }[]) {
    if (!String(r?.startedAt ?? "").startsWith(month)) continue;
    const principal = typeof r.by === "string" && r.by.length > 0 ? r.by.slice(0, SPEND_LIMITS.principalLength) : null;
    let p = people.get(principal);
    if (!p) {
      p = { principal, usd: 0, runs: 0, unpriced: 0 };
      people.set(principal, p);
    }
    const amount = r.cost?.amount;
    const usd = r.cost?.currency === "USD" && typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : null;
    for (const o of [total, p]) {
      o.runs++;
      if (usd === null) o.unpriced++;
      else o.usd += usd;
    }
  }
  const byPrincipal = [...people.values()].slice(0, SPEND_LIMITS.principals).map((p) => ({ ...p, usd: roundUsd(p.usd) }));
  return { month, usd: roundUsd(total.usd), runs: total.runs, unpriced: total.unpriced, byPrincipal };
}

/** A reported listing, checked as studio's lobby checks it: undefined when none was reported, or the reason it is refused. */
function parseListing(raw: unknown): { listing?: BoxListing } | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: 'The listing is { "published", "title", "line" }.' };
  const { published, title = "", line = "" } = raw as { published?: unknown; title?: unknown; line?: unknown };
  if (typeof title !== "string" || title.length > LISTING_LIMITS.title || CONTROL.test(title)) return { error: `The listing's title is a string of at most ${LISTING_LIMITS.title} characters with no control character.` };
  if (typeof line !== "string" || line.length > LISTING_LIMITS.line || CONTROL.test(line)) return { error: `The listing's line is a string of at most ${LISTING_LIMITS.line} characters with no control character.` };
  if (published !== undefined && typeof published !== "boolean") return { error: "The listing's published is true or false." };
  return { listing: { published: published !== false, title, line } };
}

/** A reported spend, checked as studio's lobby checks it: undefined when none was reported, or the reason it is refused. */
function parseSpend(raw: unknown): { spend?: BoxSpend } | { error: string } {
  if (raw === undefined || raw === null) return {};
  const bad = { error: 'The spend is { "month", "usd", "runs", "unpriced", "byPrincipal": [{ "principal", "usd", "runs", "unpriced" }] }, from chant workspace runs --json.' };
  const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < SPEND_LIMITS.figure;
  const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < SPEND_LIMITS.figure;
  const figures = (o: { usd?: unknown; runs?: unknown; unpriced?: unknown }): SpendFigures | null =>
    money(o.usd) && count(o.runs) && count(o.unpriced) ? { usd: roundUsd(o.usd), runs: o.runs, unpriced: o.unpriced } : null;
  if (typeof raw !== "object" || Array.isArray(raw)) return bad;
  const r = raw as { month?: unknown; byPrincipal?: unknown };
  const total = figures(raw as object);
  if (!SPEND_MONTH.test(String(r.month)) || total === null) return bad;
  const list = r.byPrincipal ?? [];
  if (!Array.isArray(list) || list.length > SPEND_LIMITS.principals) return bad;
  const byPrincipal: BoxSpend["byPrincipal"] = [];
  for (const one of list as { principal?: unknown; usd?: unknown; runs?: unknown; unpriced?: unknown }[]) {
    if (!one || typeof one !== "object") return bad;
    const principal = one.principal;
    if (principal !== null && (typeof principal !== "string" || principal.length === 0 || principal.length > SPEND_LIMITS.principalLength)) return bad;
    const f = figures(one);
    if (f === null) return bad;
    byPrincipal.push({ principal, ...f });
  }
  return { spend: { month: r.month as string, ...total, byPrincipal } };
}

/**
 * A report's body, checked, kept to the entries that name `broker`, with its
 * listing and spend when it carries them (#3508); or the reason it is refused
 * with a 400. The same rules as studio's lobby (`lobby/capabilities.mjs`).
 */
export function parseDeclarationReport(body: unknown, broker: string): { capabilities: KeptCapability[]; listing?: BoxListing; spend?: BoxSpend } | { error: string } {
  const list = (body as { capabilities?: unknown } | null)?.capabilities;
  if (!Array.isArray(list)) return { error: 'The body is { "capabilities": [{ "name", "broker", "scope" }] }.' };
  if (list.length > DECLARATION_LIMITS.capabilities) return { error: `At most ${DECLARATION_LIMITS.capabilities} capabilities.` };
  const kept = new Map<string, KeptCapability>();
  for (const c of list as { name?: unknown; broker?: unknown; scope?: unknown }[]) {
    if (!c || typeof c.name !== "string" || !CAPABILITY_NAME.test(c.name)) return { error: `${JSON.stringify(c?.name)} is not a capability name.` };
    if (c.broker !== broker) continue;
    const scope = Array.isArray(c.scope) ? c.scope : [];
    if (scope.length > DECLARATION_LIMITS.scopeWords || scope.some((w) => typeof w !== "string" || w.length === 0 || w.length > DECLARATION_LIMITS.wordLength)) {
      return { error: `${c.name}'s scope is at most ${DECLARATION_LIMITS.scopeWords} words of 1 to ${DECLARATION_LIMITS.wordLength} characters.` };
    }
    const seen = kept.get(c.name) ?? { name: c.name, broker, scope: [] };
    for (const w of scope as string[]) if (!seen.scope.includes(w)) seen.scope.push(w);
    kept.set(c.name, seen);
  }
  const listed = parseListing((body as { listing?: unknown }).listing);
  if ("error" in listed) return listed;
  const spent = parseSpend((body as { spend?: unknown }).spend);
  if ("error" in spent) return spent;
  return { capabilities: [...kept.values()], ...listed, ...spent };
}

/**
 * Why `declared` (the box's last report, or undefined when it never sent
 * one) does not allow scope word `word` of `capability` through `broker`,
 * naming the entry that would; null when it does.
 */
export function declaredRefusal(declared: { capabilities?: readonly KeptCapability[] } | undefined, broker: string, capability: string, word: string): string | null {
  const entry = `{ "name": "${capability}", "broker": "${broker}", "scope": ["${word}"] }`;
  if (!declared) return `The broker has no declaration from this box yet, so it brokers nothing for it, and ${capability} ${word} needs ${entry} in the box block of its chant.workspace.json, reported to ${BROKER_ROUTES.declaration}.`;
  const found = declared.capabilities?.find((c) => c.name === capability && c.broker === broker);
  if (!found) return `This box declares no ${capability} capability brokered by ${broker}. Add ${entry} to the box block in its chant.workspace.json.`;
  if (!found.scope.includes(word)) {
    return `This box's ${capability} capability does not list ${word} in its scope (it lists ${found.scope.length ? found.scope.join(", ") : "nothing"}). Add "${word}" to that scope in the box block of its chant.workspace.json.`;
  }
  return null;
}

/** The message of a refusal body (`{ error: string }` or `{ error: { message } }`), or undefined when it is not one. */
export function refusalMessage(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string" && error !== "") return error;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message !== "" ? message : undefined;
}
