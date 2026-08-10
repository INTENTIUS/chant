/**
 * What this lexicon pins, and why it pins two different things (#1650, #1390).
 *
 * ## The version pin
 *
 * `@cedar-policy/cedar-wasm` and the Cedar *language* move independently: the
 * package is 4.12.0, the grammar it implements is 4.5 (#1648 §0). A package
 * bump that leaves the language at 4.5 cannot change what parses, so the
 * language version is the value worth asserting at generation time and the
 * package version is the one `upstreamPin` bumps. Both are recorded.
 *
 * The runtime assert is chant #1390's spirit applied to a dependency rather
 * than to a downloaded spec: generation refuses when the installed package
 * implements a different language version than the one whose resolved output
 * produced the committed artifacts. Releases are roughly monthly, so this will
 * fire — and when it does, the answer is to look at the new resolved JSON, not
 * to publish types generated from a grammar nobody checked.
 *
 * ## The content pin
 *
 * The bundled default schema (`default-schema.cedarschema`) is what generation
 * reads in this repo and in a fresh checkout, so it decides the published
 * surface. There is no upstream URL to pin, so the pin is over content: a
 * sha256 over the *resolved* JSON — the thing the emitters actually read —
 * plus the covered entity-type and action names committed beside it.
 *
 * Resolved-JSON serialization is byte-deterministic (Rust `BTreeMap` ordering,
 * 1 distinct serialization over 25 runs, #1648 §5.2), so the digest is stable.
 * It moves when the default schema is edited, and — the case the pin exists for
 * — when a cedar-wasm upgrade resolves the same schema differently. Both change
 * the generated types, and neither is visible in a diff otherwise, because
 * `src/generated/` is not committed.
 *
 * A user's own project schema is not pinned. It is their input, they own its
 * churn, and refusing to generate because they edited their own schema would be
 * absurd.
 */

import { createHash } from "crypto";
import pinnedNames from "./pinned-names.json" with { type: "json" };
import { langVersion } from "./wasm";

/** The pinned `@cedar-policy/cedar-wasm` version — what `upstreamPin` bumps. */
export const CEDAR_WASM_VERSION = "4.12.0";

/** The Cedar *language* version that package implements (`getCedarLangVersion()`). */
export const CEDAR_LANG_VERSION = "4.5";

/** Env var that proceeds past a language-version mismatch for one run. */
export const ACCEPT_LANG_ENV = "CHANT_ACCEPT_CEDAR_LANG";

/** Env var that accepts a moved default-schema digest, printing the new pin. */
export const ACCEPT_SCHEMA_ENV = "CHANT_ACCEPT_CEDAR_SCHEMA";

/**
 * The entity types and action UIDs the pinned default schema resolved to.
 *
 * Committed beside the digest for the same reason aws commits its type names:
 * without the list, accepting a new pin is one opaque hash replacing another,
 * and the generated artifacts cannot stand in because they are gitignored.
 */
export const PINNED_SCHEMA_NAMES: readonly string[] = pinnedNames as string[];

export interface SchemaPin {
  /** `sha256:…` over the resolved schema JSON. */
  readonly digest: string;
  /** How many entity types and actions the pinned schema declared. */
  readonly declarations: number;
  /** ISO date the pin was accepted, so a diff reads as a decision. */
  readonly accepted: string;
}

/**
 * The accepted default schema.
 *
 * To move it: run generation, read the refusal, confirm the delta is one you
 * want, and paste the printed block here in its own commit.
 */
export const CEDAR_SCHEMA_PIN: SchemaPin = {
  digest: "sha256:8f86a4e4fd6845c245c84d226277741c41d29da6a173f01477bda3a662dd3ec9",
  declarations: 16,
  accepted: "2026-08-10",
};

/**
 * Digest the resolved schema JSON.
 *
 * Hashes the canonical serialization the wasm produced, not the authored
 * `.cedarschema` text: reformatting a schema, or reordering its entity types,
 * changes the text and not one byte of what the emitters read.
 */
export function resolvedSchemaDigest(resolved: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(resolved)).digest("hex")}`;
}

/** What moved between the pinned schema and the one just resolved. */
export interface SchemaDrift {
  digest: string;
  declarations: number;
  added: string[];
  removed: string[];
}

/** Compare a freshly resolved schema against a pin. `null` when it matches. */
export function schemaDrift(
  resolved: unknown,
  names: readonly string[],
  pinnedNamesList: readonly string[] = PINNED_SCHEMA_NAMES,
  pin: SchemaPin = CEDAR_SCHEMA_PIN,
): SchemaDrift | null {
  const digest = resolvedSchemaDigest(resolved);
  if (digest === pin.digest) return null;

  const current = new Set(names);
  const pinned = new Set(pinnedNamesList);
  return {
    digest,
    declarations: current.size,
    added: [...current].filter((n) => !pinned.has(n)).sort(),
    removed: [...pinned].filter((n) => !current.has(n)).sort(),
  };
}

/** The report a mismatch produces. */
export function schemaDriftMessage(drift: SchemaDrift, pin: SchemaPin = CEDAR_SCHEMA_PIN): string {
  const delta = drift.declarations - pin.declarations;
  const countLine =
    delta === 0
      ? `${drift.declarations} declarations, unchanged in count`
      : `${drift.declarations} declarations, ${delta > 0 ? "+" : ""}${delta} against the pin`;

  const lines = [
    "The bundled default Cedar schema no longer resolves to the pinned JSON.",
    "",
    `  pinned    ${pin.digest}  (${pin.declarations} declarations, accepted ${pin.accepted})`,
    `  resolved  ${drift.digest}  (${countLine})`,
  ];

  if (drift.added.length > 0) {
    lines.push(`  added     ${summarize(drift.added)}`);
  }
  if (drift.removed.length > 0) {
    lines.push(`  removed   ${summarize(drift.removed)}`);
  }

  lines.push(
    "",
    "Either the schema was edited or cedar-wasm resolves it differently than",
    "the version the committed surface was generated from. Both rewrite the",
    "generated types, and src/generated/ is not committed, so neither shows up",
    "in a diff on its own.",
    "",
    "Confirm the delta is one you want and update lexicons/cedar/src/spec/pin.ts",
    "and pinned-names.json, in their own commit:",
    "",
    `  digest: "${drift.digest}",`,
    `  declarations: ${drift.declarations},`,
    `  accepted: "<today>",`,
    "",
    `Or re-run with ${ACCEPT_SCHEMA_ENV}=1 to proceed this once and print the same block.`,
  );

  return lines.join("\n");
}

function summarize(names: string[]): string {
  return `${names.slice(0, 5).join(", ")}${names.length > 5 ? ` (+${names.length - 5} more)` : ""}`;
}

/**
 * Refuse a default schema whose resolved JSON does not match the pin.
 *
 * Unlike aws, this one refuses on any digest move rather than only on a
 * declaration-set change. It can afford to: the input is a file in this repo
 * and a dependency at a pinned version, neither of which changes under the
 * build's feet the way a republished CloudFormation archive does.
 */
export function assertPinnedSchema(
  resolved: unknown,
  names: readonly string[],
  options: {
    pin?: SchemaPin;
    pinnedNames?: readonly string[];
    env?: NodeJS.ProcessEnv;
    warn?: (message: string) => void;
  } = {},
): void {
  const pin = options.pin ?? CEDAR_SCHEMA_PIN;
  const drift = schemaDrift(resolved, names, options.pinnedNames ?? PINNED_SCHEMA_NAMES, pin);
  if (!drift) return;

  const env = options.env ?? process.env;
  const warn = options.warn ?? ((m: string) => console.error(m));
  const message = schemaDriftMessage(drift, pin);

  if (env[ACCEPT_SCHEMA_ENV]) {
    warn(message);
    return;
  }
  throw new Error(message);
}

/**
 * Refuse to generate against a Cedar language version other than the pinned one.
 *
 * chant #1390's rule, one level up the supply chain: a lexicon does not emit
 * types derived from a grammar nobody chose. `getCedarLangVersion()` is the
 * right probe because it is the number that decides what parses — the package
 * version moves monthly and mostly does not.
 */
export function assertPinnedLangVersion(
  options: {
    actual?: string;
    expected?: string;
    env?: NodeJS.ProcessEnv;
    warn?: (message: string) => void;
  } = {},
): void {
  const expected = options.expected ?? CEDAR_LANG_VERSION;
  const actual = options.actual ?? langVersion();
  if (actual === expected) return;

  const message = [
    `Cedar language version mismatch: cedar-wasm reports ${actual}, this lexicon pins ${expected}.`,
    "",
    "The installed @cedar-policy/cedar-wasm implements a different grammar than",
    "the one the generated entity and action types were derived from. Generation",
    "refuses rather than emitting a surface nobody reviewed.",
    "",
    "To accept it: check the resolved schema JSON for shape changes, update",
    `CEDAR_LANG_VERSION (and CEDAR_WASM_VERSION) in lexicons/cedar/src/spec/pin.ts,`,
    "and refresh the schema pin in the same commit.",
    "",
    `Or re-run with ${ACCEPT_LANG_ENV}=1 to proceed this once.`,
  ].join("\n");

  const env = options.env ?? process.env;
  if (env[ACCEPT_LANG_ENV]) {
    (options.warn ?? ((m: string) => console.error(m)))(message);
    return;
  }
  throw new Error(message);
}
