/**
 * Shared reading helpers for the cedar post-synth checks.
 *
 * Every check in this directory judges the same artifact: the JSON policy-set
 * envelope the serializer writes beside the `.cedar` text
 * (`policies.cedar.json` — see `../../serializer.ts`). The text and the JSON
 * are rendered from one in-memory model, so a finding against the JSON is a
 * finding against both; the JSON is the one with structure worth walking.
 *
 * Excluded from check auto-discovery by the "helper" filename filter
 * (`listRuleFiles` in core's `lint/discover.ts`).
 */
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";

/** Files carrying a Cedar JSON policy set end with this. */
export const CEDAR_JSON_SUFFIX = ".cedar.json";

/** The lexicon name stamped on every diagnostic from this directory. */
export const CEDAR_LEXICON = "cedar";

// ── The shape of what we read ─────────────────────────────────────
//
// Deliberately loose: these checks also run over a policy set that chant did
// not write (`chant audit` over a checked-in `policies.cedar.json`), so every
// field is `unknown` until a narrowing helper has looked at it.

/** One scope position of a policy in Cedar's JSON policy format. */
export interface CedarScopeJson {
  op?: unknown;
  entity?: unknown;
  entities?: unknown;
  entity_type?: unknown;
  in?: unknown;
}

/** One `when`/`unless` clause. */
export interface CedarConditionJson {
  kind?: unknown;
  body?: unknown;
}

/** A single policy in Cedar's JSON policy format. */
export interface CedarPolicyJson {
  effect?: unknown;
  principal?: unknown;
  action?: unknown;
  resource?: unknown;
  conditions?: unknown;
  annotations?: unknown;
}

/** The policy-set envelope: what `policies.cedar.json` holds. */
export interface CedarPolicySetDoc {
  staticPolicies?: unknown;
  templates?: unknown;
  templateLinks?: unknown;
}

/** One `[key, policy]` pair out of a policy set, with its origin. */
export interface CedarPolicyEntry {
  /** The key under `staticPolicies` — the id Cedar will report diagnostics against. */
  key: string;
  policy: CedarPolicyJson;
  /** True when the entry came from `templates` rather than `staticPolicies`. */
  template: boolean;
}

/** A policy set found in the build output, with everything needed to name it. */
export interface CedarPolicySet {
  /** The lexicon output it came from. */
  lexicon: string;
  /** A human-readable origin: the filename, or the lexicon name for a bare string output. */
  source: string;
  /** The raw JSON text, for handing straight to the wasm. */
  raw: string;
  /** Parsed envelope, or undefined when `raw` is not JSON at all. */
  doc?: CedarPolicySetDoc;
  /** The JSON parse error, when there is one. */
  parseError?: string;
  /** Static policies and templates, flattened in document order. */
  entries: CedarPolicyEntry[];
}

// ── Narrowing ─────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `permit` / `forbid` / whatever else the document claims. */
export function effectOf(policy: CedarPolicyJson): string | undefined {
  return typeof policy.effect === "string" ? policy.effect : undefined;
}

/** The three scope positions, in Cedar's own order. */
export function scopesOf(policy: CedarPolicyJson): Array<{ variable: string; scope: CedarScopeJson }> {
  const out: Array<{ variable: string; scope: CedarScopeJson }> = [];
  for (const variable of ["principal", "action", "resource"] as const) {
    const scope = policy[variable];
    if (isRecord(scope)) out.push({ variable, scope: scope as CedarScopeJson });
  }
  return out;
}

/** True when a scope position is Cedar's unconstrained "any" (`op: "All"`). */
export function scopeIsAll(scope: unknown): boolean {
  return isRecord(scope) && scope.op === "All";
}

/** Every `when`/`unless` clause, or `[]` when the policy is unconditioned. */
export function conditionsOf(policy: CedarPolicyJson): CedarConditionJson[] {
  if (!Array.isArray(policy.conditions)) return [];
  return policy.conditions.filter(isRecord) as CedarConditionJson[];
}

/** The policy's annotation map, narrowed to the string-valued entries Cedar allows. */
export function annotationsOf(policy: CedarPolicyJson): Record<string, unknown> {
  return isRecord(policy.annotations) ? policy.annotations : {};
}

/** The `@id` annotation, when it is a string. */
export function annotatedId(policy: CedarPolicyJson): string | undefined {
  const id = annotationsOf(policy).id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Whether a build's `env` (from `--env` or the project's `ownership.env`, see
 * `PostSynthContext#env`) is production-like, for the checks whose severity is
 * env-gated. Same seam and same vocabulary as the aws lexicon's
 * `isFullTierEnv`: an unset or unrecognized env is treated as non-production,
 * so a project that never passes `--env` is never unexpectedly hard-failed.
 */
export function isProdLikeEnv(env: string | undefined): boolean {
  return env === "prod" || env === "production" || env === "full";
}

// ── Reading policy sets out of the build output ───────────────────

/** Every candidate policy-set document in the build, parsed or not. */
export function policySets(ctx: PostSynthContext): CedarPolicySet[] {
  const sets: CedarPolicySet[] = [];

  for (const [lexicon, output] of ctx.outputs) {
    if (typeof output === "string") {
      // A bare string output. `createPostSynthContext` and `chant audit` over a
      // standalone file both land here; only JSON is a policy set, `.cedar`
      // text is the human-facing twin and carries nothing the JSON does not.
      //
      // Every lexicon's output shares this map, and several of them are JSON,
      // so "is it JSON" is not enough to claim one: take it when it came from
      // the cedar output (where even unparseable content is a cedar finding —
      // CEDC010 reports it) or when it is unmistakably a policy-set envelope.
      if (!looksLikeJson(output)) continue;
      const set = readSet(lexicon, lexicon, output);
      if (lexicon === CEDAR_LEXICON || isPolicySetEnvelope(set.doc)) sets.push(set);
      continue;
    }
    for (const [filename, content] of Object.entries(output.files ?? {})) {
      if (!filename.endsWith(CEDAR_JSON_SUFFIX)) continue;
      if (typeof content !== "string") continue;
      sets.push(readSet(lexicon, filename, content));
    }
  }

  return sets;
}

/** The subset of {@link policySets} that parsed as JSON. */
export function parsedPolicySets(ctx: PostSynthContext): CedarPolicySet[] {
  return policySets(ctx).filter((set) => set.doc !== undefined);
}

function looksLikeJson(text: string): boolean {
  return text.trimStart().startsWith("{");
}

/** The `PolicySet` envelope has one of these two keys; nothing else does. */
function isPolicySetEnvelope(doc: CedarPolicySetDoc | undefined): boolean {
  return doc !== undefined && (isRecord(doc.staticPolicies) || isRecord(doc.templates));
}

function readSet(lexicon: string, source: string, raw: string): CedarPolicySet {
  let doc: CedarPolicySetDoc | undefined;
  let parseError: string | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) doc = parsed as CedarPolicySetDoc;
    else parseError = "policy set is not a JSON object";
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  return { lexicon, source, raw, doc, parseError, entries: doc ? flatten(doc) : [] };
}

function flatten(doc: CedarPolicySetDoc): CedarPolicyEntry[] {
  const entries: CedarPolicyEntry[] = [];
  for (const [group, template] of [
    [doc.staticPolicies, false],
    [doc.templates, true],
  ] as const) {
    if (!isRecord(group)) continue;
    for (const [key, policy] of Object.entries(group)) {
      if (isRecord(policy)) entries.push({ key, policy: policy as CedarPolicyJson, template });
    }
  }
  return entries;
}
