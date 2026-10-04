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
}

/**
 * A report's body, checked, kept to the entries that name `broker`; or the
 * reason it is refused with a 400. The same rules as studio's lobby
 * (`lobby/capabilities.mjs`).
 */
export function parseDeclarationReport(body: unknown, broker: string): { capabilities: KeptCapability[] } | { error: string } {
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
  return { capabilities: [...kept.values()] };
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
