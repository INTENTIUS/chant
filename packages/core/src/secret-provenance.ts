/**
 * Secret provenance vocabulary (chant #1828, epic #1365).
 *
 * A secret's PROVENANCE is where its value comes from — never what the value
 * is. chant's constitutional line on secrets: no code path may hold, log,
 * hash, or compare a secret value. This module makes that structural: the
 * declaration types have no field that could carry material, the factory
 * rejects material-shaped fields at both the type level (`never` fields) and
 * at runtime (own-property check, naming only the offending KEY), and
 * "mismatch" anywhere downstream means presence, declared key-set, and
 * metadata — never a value or a value-derived hash (#1365 decision 6).
 *
 * The closed kind set:
 *
 * - `referenced` — the value exists out of band (a human or an external
 *   process put it where consumers read it). chant records only that the
 *   estate depends on it, which is what lets the consumed-but-unproduced
 *   check (#1382) ship as an error instead of a guess.
 * - `from-provider` — a declared provider binding materializes it (the
 *   operator/CRD seam; `K8s::Infisical::InfisicalSecret` from #1321 is the
 *   exemplar). The declaration POINTS at that binding, it does not re-model
 *   it.
 * - `generated-once` — minted on first materialization, then never
 *   regenerated (present means done). The declaration carries contract flags
 *   only — e.g. the declared key-set — never mint parameters holding
 *   material. `generated-once` secrets never enter the prunable set (#1365
 *   decision 5).
 * - `committed-encrypted` — sops-style ciphertext committed in the repo,
 *   decrypted by the delivery system (Flux) straight into the target. The
 *   declaration records a repo-relative PATH to the ciphertext, never the
 *   bytes: the factory is pure and touches no filesystem, so it still folds
 *   under `--sandbox`. The bytes are read at `buildRoots()` — the one
 *   sanctioned impure seam — and emitted as a sidecar file, never as a
 *   document in the primary output. See
 *   `docs/design/committed-encrypted-sops-provenance.md`.
 *
 * Declarations are serializer-neutral: discovery collects them like any
 * entity (they are Declarables), but `partitionByLexicon` (../build.ts)
 * excludes them from every serializer partition, so no lexicon ever emits
 * them. They are data that lint rules and lexicons READ (via
 * {@link collectSecretDeclarations}), not output.
 */

import { DECLARABLE_MARKER, type Declarable } from "./declarable";

/** The closed union of secret origins. */
export type SecretProvenance =
  | "referenced"
  | "from-provider"
  | "generated-once"
  | "committed-encrypted";

/** Every provenance kind, for exhaustiveness checks. */
export const SECRET_PROVENANCE_KINDS: readonly SecretProvenance[] = [
  "referenced",
  "from-provider",
  "generated-once",
  "committed-encrypted",
];

/**
 * Encryption tools a {@link CommittedEncryptedSecretDeclaration} understands.
 * A closed union with one member, not a free string: a second tool later is a
 * deliberate widening with a detection rule attached, not an unvalidated
 * string that silently means nothing.
 */
export type SecretEncryption = "sops";

/** Every encryption tool, for exhaustiveness checks. */
export const SECRET_ENCRYPTION_TOOLS: readonly SecretEncryption[] = ["sops"];

/**
 * File extensions a committed ciphertext path may carry (v1).
 *
 * The CLI writer round-trips every additional file through `JSON.parse` and
 * re-emits it key-sorted when the parse succeeds
 * (`./cli/commands/build.ts`), which would silently rewrite a `.sops.json`
 * file and break the byte-for-byte guarantee. v1 refuses anything but YAML;
 * the writer additionally skips the round trip for these files, so byte
 * identity is structural rather than a happy accident of JSON.parse failing.
 */
const CIPHERTEXT_FILE_EXTENSIONS = [".yaml", ".yml"] as const;

/**
 * Patterns that mean a PRIVATE key was pasted where a public recipient
 * belongs. Matched against `recipients` entries; the thrown message names the
 * field and the index, never the value.
 */
const PRIVATE_KEY_MARKERS = [/AGE-SECRET-KEY-/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

/** Marker symbol identifying a secret provenance declaration. `Symbol.for` so
 * it survives the entity-wire codec (../discovery/entity-wire-codec.ts). */
export const SECRET_DECLARATION_MARKER = Symbol.for("chant.secret-declaration");

/** The `entityType` every secret declaration carries. */
export const SECRET_DECLARATION_ENTITY_TYPE = "Chant::SecretProvenance";

/**
 * Points a `from-provider` declaration at the provider binding that
 * materializes the secret — the CRD seam, not a re-model of it. The binding
 * itself is an ordinary declarable in its own lexicon (e.g. an
 * `InfisicalSecret` instance, #1321); this ref names it so lint can resolve
 * the pair without core depending on any lexicon.
 */
export interface SecretProviderRef {
  /** Entity name (export name) of the provider binding declarable in this project. */
  readonly binding: string;
  /**
   * Expected `entityType` of the binding (e.g.
   * `"K8s::Infisical::InfisicalSecret"`). Optional; when present, lint can
   * verify the named binding is actually the kind of seam the declaration
   * claims.
   */
  readonly entityType?: string;
}

/**
 * Fields that would carry secret material, forbidden by construction. Typed
 * as `never` on every factory input so they fail to compile even when the
 * input object was widened or spread (plain excess-property checks only catch
 * object literals). The runtime check in {@link declareSecret} is the same
 * list, for untyped callers.
 */
interface NoSecretMaterial {
  readonly value?: never;
  readonly data?: never;
  readonly stringData?: never;
  readonly material?: never;
  readonly plaintext?: never;
  readonly ciphertext?: never;
}

const FORBIDDEN_MATERIAL_FIELDS = [
  "value",
  "data",
  "stringData",
  "material",
  "plaintext",
  "ciphertext",
] as const;

/** Fields shared by every secret declaration. */
interface SecretDeclarationBase extends Declarable {
  readonly [SECRET_DECLARATION_MARKER]: true;
  readonly lexicon: "chant";
  readonly entityType: typeof SECRET_DECLARATION_ENTITY_TYPE;
  /** The secret's name as consumers know it (e.g. the k8s Secret name). */
  readonly name: string;
  /** Which of the closed kind set this declaration is. */
  readonly provenance: SecretProvenance;
}

/** A secret whose value exists out of band. */
export interface ReferencedSecretDeclaration extends SecretDeclarationBase {
  readonly provenance: "referenced";
  /** Where consumers find it — free-form (a namespace, a vault path, a doc link). */
  readonly scope?: string;
}

/** A secret a declared provider binding materializes. */
export interface FromProviderSecretDeclaration extends SecretDeclarationBase {
  readonly provenance: "from-provider";
  readonly provider: SecretProviderRef;
}

/** A secret minted on first materialization and never regenerated. */
export interface GeneratedOnceSecretDeclaration extends SecretDeclarationBase {
  readonly provenance: "generated-once";
  /**
   * The declared key-set of the materialized secret. This is the contract a
   * materializer (#1830) checks for mismatch — presence and keys, never
   * values.
   */
  readonly keys?: readonly string[];
}

/**
 * A secret whose ciphertext is committed to the repo and decrypted by the
 * delivery system on the way into the target.
 *
 * The declaration is a POINTER: `file` is a repo-relative path, and nothing
 * here carries bytes. That is what keeps the factory pure — the ciphertext is
 * read at `buildRoots()` and emitted as a sidecar, never inlined into the
 * primary output an applier reads.
 */
export interface CommittedEncryptedSecretDeclaration extends SecretDeclarationBase {
  readonly provenance: "committed-encrypted";
  /** Repo-relative path to the committed ciphertext file. */
  readonly file: string;
  /** Encryption tool. Defaults to `"sops"` when omitted. */
  readonly encryption: SecretEncryption;
  /**
   * Public recipient identifiers — age recipients or PGP fingerprints. Public
   * by definition, which is the opposite of material; a private key here is
   * refused by the factory.
   */
  readonly recipients?: readonly string[];
  /**
   * The declared key-set of the decrypted Secret — the same contract meaning
   * as {@link GeneratedOnceSecretDeclaration.keys}: presence and key names,
   * never values. SOPS leaves key NAMES cleartext, so this is checkable
   * against the file itself.
   */
  readonly keys?: readonly string[];
}

/** A secret provenance declaration — the discriminant is `provenance`. */
export type SecretDeclaration =
  | ReferencedSecretDeclaration
  | FromProviderSecretDeclaration
  | GeneratedOnceSecretDeclaration
  | CommittedEncryptedSecretDeclaration;

/** Narrow a declaration to the committed-encrypted kind. */
export function isCommittedEncryptedSecret(
  decl: SecretDeclaration,
): decl is CommittedEncryptedSecretDeclaration {
  return decl.provenance === "committed-encrypted";
}

/** Factory input for a `referenced` secret. */
export interface ReferencedSecretInput extends NoSecretMaterial {
  readonly name: string;
  readonly provenance: "referenced";
  readonly scope?: string;
}

/** Factory input for a `from-provider` secret. */
export interface FromProviderSecretInput extends NoSecretMaterial {
  readonly name: string;
  readonly provenance: "from-provider";
  readonly provider: SecretProviderRef;
}

/** Factory input for a `generated-once` secret. */
export interface GeneratedOnceSecretInput extends NoSecretMaterial {
  readonly name: string;
  readonly provenance: "generated-once";
  readonly keys?: readonly string[];
}

/** Factory input for a `committed-encrypted` secret. */
export interface CommittedEncryptedSecretInput extends NoSecretMaterial {
  readonly name: string;
  readonly provenance: "committed-encrypted";
  /**
   * Repo-relative path to the committed ciphertext file — `file`, never
   * `ciphertext`: the declaration points at bytes, it does not carry them,
   * and `ciphertext` is a forbidden material field.
   */
  readonly file: string;
  /** Encryption tool. Closed union; `"sops"` is its only member today. */
  readonly encryption?: SecretEncryption;
  /** Public recipient identifiers — age recipients or PGP fingerprints. */
  readonly recipients?: readonly string[];
  /** The declared key-set of the decrypted Secret. Names only, never values. */
  readonly keys?: readonly string[];
}

export type SecretDeclarationInput =
  | ReferencedSecretInput
  | FromProviderSecretInput
  | GeneratedOnceSecretInput
  | CommittedEncryptedSecretInput;

/**
 * Declare a secret's provenance. The returned object is a locked Declarable:
 * discovery collects it like any entity, `chant list` shows it, lint and
 * lexicons read it — and no serializer ever emits it.
 *
 * Only the fields the kind defines are copied onto the declaration; anything
 * else on the input — in particular anything that could carry material — is
 * either a compile error ({@link NoSecretMaterial}) or a thrown error here.
 * The thrown message names the offending KEY only, never its value.
 */
export function declareSecret(input: ReferencedSecretInput): ReferencedSecretDeclaration;
export function declareSecret(input: FromProviderSecretInput): FromProviderSecretDeclaration;
export function declareSecret(input: GeneratedOnceSecretInput): GeneratedOnceSecretDeclaration;
export function declareSecret(
  input: CommittedEncryptedSecretInput,
): CommittedEncryptedSecretDeclaration;
export function declareSecret(input: SecretDeclarationInput): SecretDeclaration {
  if (typeof input.name !== "string" || input.name.length === 0) {
    throw new Error("declareSecret: `name` must be a non-empty string");
  }
  if (!SECRET_PROVENANCE_KINDS.includes(input.provenance)) {
    throw new Error(
      `declareSecret("${input.name}"): unknown provenance "${String(input.provenance)}" — ` +
        `expected one of ${SECRET_PROVENANCE_KINDS.join(", ")}`,
    );
  }
  for (const field of FORBIDDEN_MATERIAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      // Name the key only. Never read, log, or echo the value.
      throw new Error(
        `declareSecret("${input.name}"): field "${field}" is not allowed — ` +
          `a secret declaration records provenance, never material`,
      );
    }
  }

  const base = {
    [DECLARABLE_MARKER]: true,
    [SECRET_DECLARATION_MARKER]: true,
    lexicon: "chant",
    entityType: SECRET_DECLARATION_ENTITY_TYPE,
    name: input.name,
  } as const;

  // Copy known fields per kind explicitly — never spread `input`, so a field
  // that slipped past the type system still cannot land on the declaration.
  // The top-level object stays extensible (discovery stamps logical-name and
  // provenance symbols onto entities); the declared fields themselves are
  // defined non-writable below, and nested structures are frozen.
  switch (input.provenance) {
    case "referenced": {
      const decl: ReferencedSecretDeclaration = {
        ...base,
        provenance: "referenced",
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
      };
      return lockDeclaredFields(decl);
    }
    case "from-provider": {
      if (typeof input.provider?.binding !== "string" || input.provider.binding.length === 0) {
        throw new Error(
          `declareSecret("${input.name}"): from-provider requires \`provider.binding\` ` +
            `naming the provider binding entity`,
        );
      }
      const decl: FromProviderSecretDeclaration = {
        ...base,
        provenance: "from-provider",
        provider: Object.freeze({
          binding: input.provider.binding,
          ...(input.provider.entityType !== undefined ? { entityType: input.provider.entityType } : {}),
        }),
      };
      return lockDeclaredFields(decl);
    }
    case "generated-once": {
      const decl: GeneratedOnceSecretDeclaration = {
        ...base,
        provenance: "generated-once",
        ...(input.keys !== undefined ? { keys: Object.freeze([...input.keys]) } : {}),
      };
      return lockDeclaredFields(decl);
    }
    case "committed-encrypted": {
      const decl: CommittedEncryptedSecretDeclaration = {
        ...base,
        provenance: "committed-encrypted",
        file: validateCiphertextPath(input.name, input.file),
        encryption: validateEncryption(input.name, input.encryption),
        ...(input.recipients !== undefined
          ? { recipients: Object.freeze(validateRecipients(input.name, input.recipients)) }
          : {}),
        ...(input.keys !== undefined ? { keys: Object.freeze([...input.keys]) } : {}),
      };
      return lockDeclaredFields(decl);
    }
  }
}

/**
 * Validate the repo-relative ciphertext path. Pure and offline — the factory
 * never stats the file, because discovery folds project source statically
 * under `--sandbox` and a factory that touched the filesystem would either
 * break folding or reintroduce the trust boundary that suite defends. The
 * file's existence and shape are checked at `buildRoots()` instead.
 */
function validateCiphertextPath(name: string, file: unknown): string {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error(
      `declareSecret("${name}"): committed-encrypted requires \`file\`, a non-empty ` +
        `repo-relative path to the committed ciphertext`,
    );
  }
  if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)) {
    throw new Error(
      `declareSecret("${name}"): \`file\` must be repo-relative, not absolute — got "${file}"`,
    );
  }
  const segments = file.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(
      `declareSecret("${name}"): \`file\` must not escape the project with a ".." segment — ` +
        `got "${file}"`,
    );
  }
  const dot = file.lastIndexOf(".");
  const extension = dot === -1 ? "" : file.slice(dot).toLowerCase();
  if (!(CIPHERTEXT_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new Error(
      `declareSecret("${name}"): \`file\` must be a YAML file ` +
        `(${CIPHERTEXT_FILE_EXTENSIONS.join(", ")}) — got "${extension || "no extension"}". ` +
        `Other formats are not emitted byte-for-byte yet.`,
    );
  }
  return file;
}

/** Validate the encryption tool, defaulting to `"sops"`. */
function validateEncryption(name: string, encryption: unknown): SecretEncryption {
  if (encryption === undefined) return "sops";
  if (!(SECRET_ENCRYPTION_TOOLS as readonly unknown[]).includes(encryption)) {
    throw new Error(
      `declareSecret("${name}"): unknown encryption "${String(encryption)}" — ` +
        `expected one of ${SECRET_ENCRYPTION_TOOLS.join(", ")}`,
    );
  }
  return encryption as SecretEncryption;
}

/**
 * Copy `recipients`, refusing a private key pasted where a public recipient
 * belongs. The message names the field and the index — never the value, the
 * same discipline the forbidden-material check above uses.
 */
function validateRecipients(name: string, recipients: readonly string[]): string[] {
  const copied = [...recipients];
  copied.forEach((recipient, index) => {
    if (typeof recipient !== "string" || recipient.length === 0) {
      throw new Error(
        `declareSecret("${name}"): \`recipients[${index}]\` must be a non-empty string`,
      );
    }
    if (PRIVATE_KEY_MARKERS.some((pattern) => pattern.test(recipient))) {
      throw new Error(
        `declareSecret("${name}"): \`recipients[${index}]\` looks like a PRIVATE key — ` +
          `recipients are public identifiers (age recipients, PGP fingerprints). ` +
          `Rotate it: it has been in a source file.`,
      );
    }
  });
  return copied;
}

/**
 * Make every declared (string-keyed) field non-writable and non-configurable
 * without sealing the object — discovery still stamps its own symbol-keyed
 * metadata (logical name, build provenance) onto entities, which a frozen
 * object would reject.
 */
function lockDeclaredFields<T extends object>(decl: T): T {
  for (const key of Object.keys(decl)) {
    Object.defineProperty(decl, key, { writable: false, configurable: false });
  }
  return decl;
}

/** Type guard for a secret provenance declaration. */
export function isSecretDeclaration(value: unknown): value is SecretDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    SECRET_DECLARATION_MARKER in value &&
    (value as Record<symbol, unknown>)[SECRET_DECLARATION_MARKER] === true
  );
}

/**
 * Extract the secret declarations from a discovered entity map — the read
 * surface for lint rules (#1382) and lexicon materializers (#1830). Keyed by
 * entity name (export name), the same key `DiscoveryResult.entities` uses.
 */
export function collectSecretDeclarations(
  entities: ReadonlyMap<string, Declarable>,
): Map<string, SecretDeclaration> {
  const out = new Map<string, SecretDeclaration>();
  for (const [name, entity] of entities) {
    if (isSecretDeclaration(entity)) out.set(name, entity);
  }
  return out;
}
