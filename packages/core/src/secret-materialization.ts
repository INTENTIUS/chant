/**
 * Generated-once secret materialization — the one implementation behind the
 * `ensure-secret` capability verb (components/verbs/ensure-secret.ts) and the
 * `ensureSecret(...)` op step builder (op/builders.ts). chant #1829, epic
 * #1365 decisions 3 and 6.
 *
 * The contract is read-then-write:
 *
 * - Absent: mint once, through the store adapter, and report `created`.
 * - Present: verify presence, the declared key-set, and any declared
 *   metadata, then STOP — present means done. Never mint over an existing
 *   value. Never rotate implicitly. A re-run of a whole deploy leaves the
 *   stored bytes untouched.
 * - Mismatch: fail loudly, naming what mismatched — key names and metadata
 *   keys, never a value or a value-derived hash (#1365 decision 6).
 *
 * The constitutional line (../secret-provenance.ts): no code path here may
 * hold, log, hash, or compare a secret value. That is structural, not
 * discipline:
 *
 * - {@link ensureSecretMaterialization} never calls the generator. It hands
 *   the generator to the store adapter's `create`, which consumes the
 *   material as it writes. The engine's result type has no field that could
 *   carry material.
 * - The generator produces {@link SecretMaterial}, an opaque single-use
 *   handle. The plaintext lives in a module-private WeakMap, not on the
 *   object: enumeration, `JSON.stringify`, `String(...)`, and `util.inspect`
 *   all see only a redaction marker. Only {@link consumeSecretMaterial} —
 *   meant for store adapters, at the write — yields the plaintext, exactly
 *   once; a second consume throws.
 * - `describe` returns key names and metadata only, so the mismatch check
 *   has nothing value-shaped to compare even by accident.
 *
 * Store adapters are per-provider (#1830 is the k8s row); core defines only
 * the seam.
 */

import { randomBytes } from "node:crypto";

// ── Opaque secret material ────────────────────────────────────────────────────

/** Module-private plaintext vault. Keyed by handle identity; consuming deletes. */
const vault = new WeakMap<SecretMaterial, string>();

const REDACTED = "[secret material]";

/**
 * A single-use, opaque handle to generated secret material. The plaintext is
 * not a property of this object — it lives in a module-private WeakMap — so
 * spreading, enumerating, stringifying, or logging the handle yields only a
 * redaction marker. A store adapter redeems it with
 * {@link consumeSecretMaterial} at the moment it writes; nothing else can.
 */
export class SecretMaterial {
  private constructor() {}

  /** Wrap plaintext in an opaque handle. Call inside a generator only. */
  static mint(plaintext: string): SecretMaterial {
    const handle = new SecretMaterial();
    vault.set(handle, plaintext);
    return handle;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /** node:util.inspect (console.log) sees the redaction marker, not the vault. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

/**
 * Redeem a {@link SecretMaterial} handle for its plaintext — exactly once.
 * For store adapters only, at the write to the backing store. Throws if the
 * handle was already consumed (or was never minted here): material flows to
 * the store exactly once and is retained nowhere.
 */
export function consumeSecretMaterial(material: SecretMaterial): string {
  const plaintext = vault.get(material);
  if (plaintext === undefined) {
    throw new Error(
      "secret material already consumed — material flows to the store adapter exactly once and is never retained",
    );
  }
  vault.delete(material);
  return plaintext;
}

/**
 * Produces the material for one key of a secret being minted. Called by the
 * store adapter (never by the engine) once per declared key, at create time —
 * generation is apply-time I/O, never synthesis.
 */
export type SecretMaterialGenerator = (key: string) => SecretMaterial | Promise<SecretMaterial>;

/** 32 bytes from the CSPRNG, base64url — the default mint. */
export const defaultSecretMaterialGenerator: SecretMaterialGenerator = () =>
  SecretMaterial.mint(randomBytes(32).toString("base64url"));

// ── The store adapter seam ────────────────────────────────────────────────────

/** What `describe` reports about an existing secret: key NAMES and metadata. Never values. */
export interface SecretStoreDescription {
  /** The key names present in the stored secret. */
  readonly keys: readonly string[];
  /** Store metadata (e.g. k8s labels/annotations the provider surfaces). */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * A provider's view of one secret store — the seam #1830 (k8s) and future
 * provider rows implement. `create` receives the generator and consumes each
 * key's material as it writes; no method returns material.
 */
export interface SecretStoreAdapter {
  /** Whether a secret of this name exists in the store. */
  exists(name: string): Promise<boolean>;
  /** Key names and metadata of an existing secret. Never values. */
  describe(name: string): Promise<SecretStoreDescription>;
  /**
   * Create the secret, minting material for each declared key via
   * `generate` and writing it straight to the store. Returns nothing:
   * material must not travel back through this seam.
   */
  create(name: string, keys: readonly string[], generate: SecretMaterialGenerator): Promise<void>;
}

// ── The ensure contract ───────────────────────────────────────────────────────

/** The declared contract to ensure — names and keys only, never material. */
export interface EnsureSecretSpec {
  /** The secret's name as the store knows it. */
  readonly name: string;
  /** The declared key-set. Creation mints one value per key; verification compares names. */
  readonly keys: readonly string[];
  /** Declared metadata an existing secret must carry (compared per key; mismatches are reported by KEY). */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** What `ensureSecretMaterialization` did. No field can carry material. */
export interface EnsureSecretOutcome {
  /** `created` = minted now (first materialization); `present` = existed and matched the contract (no write). */
  readonly outcome: "created" | "present";
  /** The secret's name. */
  readonly name: string;
  /** The declared key names the contract was checked (or minted) against. */
  readonly keys: readonly string[];
}

/**
 * The loud failure: an existing secret does not match its declared contract.
 * `mismatches` names what differed — key names and metadata keys only.
 * Constructing one with anything value-shaped is the reviewer's tripwire;
 * nothing in this module can, because nothing in this module holds a value.
 */
export class SecretContractMismatchError extends Error {
  constructor(
    /** The secret's name. */
    public readonly secretName: string,
    /** Human-readable mismatch descriptions, naming keys — never values. */
    public readonly mismatches: readonly string[],
  ) {
    super(
      `secret "${secretName}" exists but does not match its declared contract: ${mismatches.join("; ")}. ` +
        `chant never mints over or rotates an existing secret — reconcile the declaration or the stored secret explicitly.`,
    );
    this.name = "SecretContractMismatchError";
  }
}

/**
 * Ensure a `generated-once` secret exists and matches its declared contract.
 * Read-then-write:
 *
 * - Absent: `store.create(name, keys, generate)` — one mint, then done.
 * - Present and matching: no write of any kind; returns `present`.
 * - Present and mismatching: throws {@link SecretContractMismatchError}
 *   naming the missing/unexpected key names and mismatched metadata keys.
 *
 * The engine never calls `generate` itself and never sees what the adapter
 * writes; its return value carries names only.
 */
export async function ensureSecretMaterialization(
  store: SecretStoreAdapter,
  spec: EnsureSecretSpec,
  generate: SecretMaterialGenerator = defaultSecretMaterialGenerator,
): Promise<EnsureSecretOutcome> {
  if (typeof spec.name !== "string" || spec.name.length === 0) {
    throw new Error("ensureSecret: `name` must be a non-empty string");
  }
  if (!Array.isArray(spec.keys) || spec.keys.length === 0) {
    throw new Error(`ensureSecret("${spec.name}"): \`keys\` must name at least one key to materialize`);
  }

  if (await store.exists(spec.name)) {
    const actual = await store.describe(spec.name);
    const mismatches: string[] = [];

    const actualKeys = new Set(actual.keys);
    const declaredKeys = new Set(spec.keys);
    const missing = spec.keys.filter((k) => !actualKeys.has(k));
    const unexpected = actual.keys.filter((k) => !declaredKeys.has(k));
    if (missing.length > 0) {
      mismatches.push(`missing declared key(s): ${missing.join(", ")}`);
    }
    if (unexpected.length > 0) {
      mismatches.push(`undeclared key(s) present: ${unexpected.join(", ")}`);
    }

    for (const [key, value] of Object.entries(spec.metadata ?? {})) {
      const actualValue = actual.metadata?.[key];
      if (actualValue === undefined) {
        mismatches.push(`missing declared metadata key: ${key}`);
      } else if (actualValue !== value) {
        // Name the KEY only — metadata values stay out of the error by rule,
        // the same line the whole module holds for secret values.
        mismatches.push(`metadata key differs: ${key}`);
      }
    }

    if (mismatches.length > 0) {
      throw new SecretContractMismatchError(spec.name, mismatches);
    }
    return { outcome: "present", name: spec.name, keys: spec.keys };
  }

  await store.create(spec.name, spec.keys, generate);
  return { outcome: "created", name: spec.name, keys: spec.keys };
}
