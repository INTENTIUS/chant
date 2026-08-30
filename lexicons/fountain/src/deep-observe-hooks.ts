/**
 * fountain deep-observation noise rules (#1217).
 *
 * Plain data, imported statically by `plugin.ts`, because core applies the
 * identical rules to the *declared* property tree — which no reader ever
 * touches — before it diffs. Burying them inside the read would normalize the
 * two sides differently and report everything as drift.
 *
 * ## Why a static table and not an ownership walk
 *
 * Kubernetes records `managedFields`, so the k8s row can subtract whatever a
 * controller owns. A fountain REST payload never says who wrote a field, so
 * this row follows the GCP precedent (`lexicons/gcp/src/deep-observe-hooks.ts`)
 * — a hand-maintained table naming what the server populates. The cost is
 * explicit: a server-set field nobody has listed reads as drift until it is
 * listed. That is visible and fixable; an over-broad rule silently hides real
 * drift, which is the worse of the two failures.
 *
 * Every value below is read off fountain's own Ecto schemas (`Environment`,
 * `Vault`, `Agent`) and the JSON views that render them, not guessed from a
 * sample payload.
 *
 * ## Secrets
 *
 * chant authors an environment's or vault's `secrets` as an ordered
 * `{key, value}[]`, so the declared node holds real secret material. Core's
 * key-name mask (`SENSITIVE_KEY_PATTERNS` matches `secrets`) collapses the
 * whole node to `[REDACTED]` on both trees before any diff sees it, which is
 * the correct outcome and also the limit of what this row can report: presence
 * — an environment that declares no secrets and has some, or the reverse —
 * never the key set, and never a value. Making the key set diffable needs
 * fountain#148's reference model, where secrets stop being inline values.
 *
 * {@link fountainDeepNormalizationHooks.mask} adds one narrow rule on top:
 * a string matching a known credential shape is collapsed wherever it appears,
 * whatever the key is called. FTN001/FTN012 already refuse those at lint time;
 * this is the backstop for a value that reached the live instance some other
 * way, so a drift row can never print one.
 */

import type {
  DeepArrayElement,
  DeepNode,
  DeepNormalizationHooks,
} from "@intentius/chant/deep-observation";
import { SERVER_FIELDS } from "./import/parser";

export const ENVIRONMENT_TYPE = "Fountain::V1::Environment";
export const VAULT_TYPE = "Fountain::V1::Vault";
export const AGENT_TYPE = "Fountain::V1::Agent";

/**
 * Top-level payload fields fountain writes and a caller cannot: the primary
 * key, the `timestamps()` pair, the owning user, the virtual `*_count` rollups
 * the `*_with_counts` reads attach, the avatar's derived media type, and `acp`
 * (computed per request from the runtime, never stored).
 *
 * Pruned on BOTH sides and regardless of what source declared, since a user who
 * writes one is writing something the API overwrites anyway.
 *
 * Matched on the whole pattern rather than its last segment: `name` and `id`
 * also occur *inside* `skills[]` and `repositories[]`, where they are authored
 * configuration. `SERVER_FIELDS` is shared with the import/export path so the
 * two cannot disagree about what a caller may author.
 */
export const FOUNTAIN_SERVER_FIELDS: ReadonlySet<string> = new Set([
  ...SERVER_FIELDS,
  "secret_count",
  "agent_count",
  "acp",
]);

/**
 * Per-kind values fountain fills in when the request omits them, keyed by the
 * index-erased pattern from the tree root.
 *
 * Noise only where **source never declared the property** — the
 * `counterpart === "absent"` gate below. A default somebody wrote out
 * explicitly is a fact worth diffing, and a later change away from it has to
 * stay reportable.
 *
 * Straight off the Ecto `schema` blocks. `networking_type: "unrestricted"` is
 * the one worth arguing about: subtracting it means an environment that never
 * states its networking posture does not report one. That case is FTN010's, at
 * lint time, where it is a build finding rather than drift; and the case this
 * row exists for — a reviewed `limited` environment flipped to `unrestricted`
 * in the UI — has a declared counterpart, so the gate keeps it and it reports
 * as `changed`.
 */
export const FOUNTAIN_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  [ENVIRONMENT_TYPE]: {
    setup_script: "",
    networking_type: "unrestricted",
    repositories: [],
  },
  [VAULT_TYPE]: {
    description: "",
  },
  [AGENT_TYPE]: {
    description: "",
    system: "",
    skills: [],
    // ADR 0023. Not on the committed spec snapshot yet, so an instance that
    // predates it simply never emits the field.
    sandbox_mode: "ephemeral",
  },
};

/**
 * Credential shapes FTN001 refuses in source and FTN012 refuses in `env_vars`.
 * Reused here as the mask's own rule so the two lists cannot drift apart in
 * what they call a credential.
 */
const CREDENTIAL_VALUE_SHAPES: readonly RegExp[] = [
  /^AKIA[0-9A-Z]{16}$/,
  /^(ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^sk-[A-Za-z0-9_-]{20,}$/,
  /^ftn_[A-Za-z0-9]{16,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/,
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Key-order-independent equality, so a default written as a container matches whatever order a payload arrives in. */
function equalsDefault(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (typeof expected !== typeof actual) return false;
  return canonicalJson(expected) === canonicalJson(actual);
}

function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_k, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          )
        : v,
    ) ?? ""
  );
}

/** An `{}` with nothing pruned out of it — fountain's spelling for an unset `:map` column. */
function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

/** The final segment of an index-erased pattern (`skills[].name` -> `name`). */
function lastSegment(pattern: string): string {
  const withoutIndex = pattern.replace(/\[\]$/, "");
  const dot = withoutIndex.lastIndexOf(".");
  return dot === -1 ? withoutIndex : withoutIndex.slice(dot + 1);
}

export const fountainDeepNormalizationHooks: DeepNormalizationHooks = {
  /**
   * A credential-shaped string never reaches a diff row, a log line or a
   * snapshot. Collapsed on both trees, so a value that is the same on both
   * still classifies as unchanged; a changed one classifies as changed without
   * either side being printed. Same contract as the k8s row's Secret mask
   * (#1365 decision 6): presence and paths, never values.
   */
  mask(node: DeepNode): boolean {
    return typeof node.value === "string" && CREDENTIAL_VALUE_SHAPES.some((p) => p.test(node.value as string));
  },

  prune(node: DeepNode): boolean {
    // Server-written, on either side, declared or not.
    if (FOUNTAIN_SERVER_FIELDS.has(node.pattern)) return true;

    // An authored-but-empty `secrets` list is not a fountain state: there is no
    // sub-resource to read back for it, so leaving it on the declared side
    // would report `absent` on every clean read.
    if (lastSegment(node.pattern) === "secrets" && isEmptyArray(node.value)) return true;

    // Below here: values fountain populated that source never asked for.
    // `counterpart` is a tri-state and only `absent` licenses subtraction.
    if (node.side !== "live" || node.counterpart !== "absent") return false;

    // `name` is the key the read looked the resource up by, so it can never
    // disagree with the declaration; it is undeclared only when the serializer
    // fell back to the chant export name, which is chant reading back its own
    // choice rather than drift.
    if (node.pattern === "name") return true;

    // fountain's spellings for "never configured": a nullable column and an
    // unset `:map`. `[]` is deliberately NOT in this rule — an empty
    // `allowed_vault_ids` means "no vault may attach", which is a posture
    // somebody chose, not an absence. The empty-list defaults that ARE server
    // defaults (`skills`, `repositories`) are named per kind below.
    if (node.value === null || isEmptyObject(node.value)) return true;

    const defaults = FOUNTAIN_DEFAULTS[node.entityType];
    if (!defaults || !Object.prototype.hasOwnProperty.call(defaults, node.pattern)) return false;
    return equalsDefault(defaults[node.pattern], node.value);
  },

  /**
   * The set-shaped lists. `repositories` and `skills` are keyed by their own
   * identity so one added entry does not rename every entry after it in the
   * flattened diff; the id/host lists are keyed by the element itself.
   *
   * Nothing else is reordered. An array whose elements do not all yield a key
   * keeps the order the payload arrived in, which is the right answer wherever
   * order might carry meaning.
   */
  orderKey(element: DeepArrayElement): string | undefined {
    const name = lastSegment(element.pattern);
    const el = element.element;

    if (name === "allowed_vault_ids" || name === "allowed_environment_ids" || name === "allowed_hosts") {
      return typeof el === "string" ? el : undefined;
    }

    if (name === "repositories" && isRecord(el)) {
      return typeof el.mount_path === "string" ? el.mount_path : undefined;
    }

    if (name === "skills" && isRecord(el)) {
      // An inline entry is identified by its name, a github entry by its repo.
      // Exactly one of the two is set — the server's own changeset enforces it.
      if (typeof el.name === "string") return el.name;
      if (typeof el.source === "string") return el.source;
      return undefined;
    }

    return undefined;
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
