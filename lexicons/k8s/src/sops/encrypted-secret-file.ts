/**
 * Committed SOPS ciphertext as a build artifact (epic lex00/iac-cd-bench#6).
 *
 * A `declareSecret({ provenance: "committed-encrypted", file })` names a
 * repo-relative path to ciphertext that lives in git. This module is the
 * resolution stage: at `buildRoots()` — chant's one sanctioned impure seam,
 * the same one the kustomize roots and cedar's `Schema` use — it reads those
 * bytes, validates the document is what the declaration claims, and wraps
 * them in an entity the serializer copies out VERBATIM as a sidecar file.
 *
 * Three properties this is built to keep:
 *
 * - **Never inlined.** The bytes go to `SerializerResult.files`, never into
 *   the primary multi-document YAML. chant's own appliers read the primary
 *   output, so "chant pushes an undecrypted Secret into a cluster" is
 *   structurally impossible rather than merely unlikely. Flux is the only
 *   thing that applies the sidecar, and Flux decrypts first.
 * - **Deterministic and offline.** The bytes are copied, not re-serialized:
 *   no parse-and-re-emit round trip, no key sorting, no digest. No `sops`
 *   binary is invoked in either direction, so a missing binary and a missing
 *   age key are not failure modes — the plaintext has no representation here
 *   at any stage.
 * - **Fails loudly, not weirdly.** A missing file, a non-Secret document, a
 *   name mismatch, a missing `sops` block, or a `data`/`stringData` value
 *   that is not `ENC[...]`-shaped refuses with the declared path in the
 *   message. That last check is the one that earns the feature: it catches
 *   "edited the file and forgot to re-encrypt", the exact failure mode that
 *   puts plaintext into git.
 *
 * The entity is deliberately internal — not exported from the package entry
 * point, not constructible by an author. The authored surface is
 * `declareSecret`; a public entity taking inline bytes is the one thing this
 * whole design exists to prevent.
 *
 * Design: docs/design/committed-encrypted-sops-provenance.md §3.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadAll } from "js-yaml";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import {
  ENCRYPTED_SECRET_ENTITY_PREFIX,
  ENCRYPTED_SECRET_FILE_MARKER,
  ENCRYPTED_SECRET_FILE_TYPE,
  sidecarFilename,
  type EncryptedSecretFileEntity,
} from "./entity";
import type { BuildRootContext, BuildRootContribution } from "@intentius/chant/lexicon";
import {
  collectSecretDeclarations,
  isCommittedEncryptedSecret,
  type CommittedEncryptedSecretDeclaration,
} from "@intentius/chant/secret-provenance";

export {
  ENCRYPTED_SECRET_FILE_MARKER,
  ENCRYPTED_SECRET_FILE_TYPE,
  ENCRYPTED_SECRET_ENTITY_PREFIX,
  isEncryptedSecretFileEntity,
  sidecarFilename,
  type EncryptedSecretFileEntity,
} from "./entity";

/** A parsed ciphertext document, or the reasons it is not one. */
export interface EncryptedSecretDocument {
  /** `metadata.name`, when the document had one. */
  name?: string;
  /** `metadata.namespace`, when the document had one. */
  namespace?: string;
  /** Key names found under `data`/`stringData` — names only, never values. */
  keys: string[];
}

/**
 * Validate one committed ciphertext document against its declaration.
 *
 * Returns every problem found, so an author sees all of them at once rather
 * than one per build. Both consumers share this: the `buildRoots()` stage
 * turns the list into a refusal, and WK8504 turns it into diagnostics.
 *
 * A value is only ever tested for the `ENC[` prefix, inside this one frame,
 * and only the offending KEY name is reported — the discipline
 * `declareSecret`'s own runtime guard uses.
 */
export function validateEncryptedSecretDocument(
  text: string,
  declared: { name: string; file: string },
): { problems: string[]; document?: EncryptedSecretDocument } {
  const problems: string[] = [];

  let docs: unknown[];
  try {
    docs = loadAll(text);
  } catch (err) {
    return {
      problems: [`${declared.file} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const present = docs.filter((d) => d !== null && d !== undefined);
  if (present.length === 0) {
    return { problems: [`${declared.file} contains no YAML document`] };
  }
  if (present.length > 1) {
    // v1 keys a declaration by one `name`; a declaration-per-document sharing
    // a file, or a `names: string[]` field, is a design change to make
    // deliberately rather than by accident.
    return {
      problems: [
        `${declared.file} contains ${present.length} YAML documents — ` +
          `a committed-encrypted declaration covers exactly one Secret`,
      ],
    };
  }

  const doc = present[0];
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { problems: [`${declared.file} is not a Kubernetes object`] };
  }
  const record = doc as Record<string, unknown>;

  if (record.apiVersion !== "v1" || record.kind !== "Secret") {
    problems.push(
      `${declared.file} is not a v1 Secret ` +
        `(apiVersion "${String(record.apiVersion)}", kind "${String(record.kind)}")`,
    );
  }

  const metadata = asRecord(record.metadata);
  const name = typeof metadata?.name === "string" ? metadata.name : undefined;
  const namespace = typeof metadata?.namespace === "string" ? metadata.namespace : undefined;
  if (name !== declared.name) {
    problems.push(
      `${declared.file} has metadata.name "${name ?? "(none)"}", ` +
        `but the declaration names "${declared.name}"`,
    );
  }

  // SOPS's own metadata block. Its absence means the file was never encrypted
  // (or was decrypted in place and committed), which is the whole point of
  // checking. `sops.mac` is a MAC over the PLAINTEXT — it is carried by the
  // verbatim copy and must never be read as a semantic value, so nothing here
  // looks past the block's presence.
  if (asRecord(record.sops) === undefined) {
    problems.push(
      `${declared.file} has no top-level \`sops\` block — it does not look encrypted. ` +
        `Run \`sops -e -i\` before committing.`,
    );
  }

  // Scoped to data/stringData alone: SOPS's `encrypted_regex` leaves
  // apiVersion, kind and metadata cleartext by design.
  const keys: string[] = [];
  for (const field of ["data", "stringData"] as const) {
    const block = asRecord(record[field]);
    if (block === undefined) continue;
    for (const [key, value] of Object.entries(block)) {
      keys.push(key);
      if (typeof value !== "string" || !value.startsWith("ENC[")) {
        problems.push(
          `${declared.file}: ${field}."${key}" is not encrypted (expected an ENC[...] value) — ` +
            `re-run \`sops -e -i\` before committing`,
        );
      }
    }
  }

  return { problems, document: { name, namespace, keys } };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Options for {@link resolveEncryptedSecrets} — `readFile` is injectable for tests. */
export interface ResolveEncryptedSecretsOptions {
  projectRoot: string;
  declarations: ReadonlyMap<string, CommittedEncryptedSecretDeclaration>;
  readFile?: (path: string) => string;
}

/**
 * Read and validate every committed-encrypted declaration, returning one
 * entity per resolved file. Throws on the first declaration that does not
 * resolve, with every problem for that declaration in the message — a build
 * that would emit a broken or unencrypted Secret must not proceed.
 */
export function resolveEncryptedSecrets(
  options: ResolveEncryptedSecretsOptions,
): Map<string, Declarable> {
  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const entities = new Map<string, Declarable>();
  const byFilename = new Map<string, string>();

  for (const decl of options.declarations.values()) {
    const absolute = resolve(options.projectRoot, decl.file);
    let text: string;
    try {
      text = read(absolute);
    } catch (err) {
      throw new Error(
        `declareSecret("${decl.name}"): committed ciphertext not readable at ${absolute} ` +
          `(declared as "${decl.file}") — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const { problems, document } = validateEncryptedSecretDocument(text, decl);
    if (problems.length > 0) {
      throw new Error(
        `declareSecret("${decl.name}"): committed ciphertext does not resolve —\n  ` +
          problems.join("\n  "),
      );
    }

    const filename = sidecarFilename(decl.file);
    const collides = byFilename.get(filename);
    if (collides !== undefined) {
      throw new Error(
        `declareSecret("${decl.name}"): sidecar filename "${filename}" collides with the one ` +
          `"${collides}" already emits — additional files share one flat namespace, so two ` +
          `declarations whose paths share a basename would silently overwrite each other`,
      );
    }
    byFilename.set(filename, decl.file);

    const entity: EncryptedSecretFileEntity = {
      lexicon: "k8s",
      entityType: ENCRYPTED_SECRET_FILE_TYPE,
      filename,
      text,
      secretName: decl.name,
      ...(document?.namespace !== undefined ? { namespace: document.namespace } : {}),
      sourcePath: decl.file,
      [DECLARABLE_MARKER]: true,
      [ENCRYPTED_SECRET_FILE_MARKER]: true,
    };
    entities.set(`${ENCRYPTED_SECRET_ENTITY_PREFIX}${decl.name}`, entity);
  }

  return entities;
}

/** Every committed-encrypted declaration in an entity map, keyed by entity name. */
export function committedEncryptedDeclarations(
  entities: ReadonlyMap<string, Declarable>,
): Map<string, CommittedEncryptedSecretDeclaration> {
  const out = new Map<string, CommittedEncryptedSecretDeclaration>();
  for (const [name, decl] of collectSecretDeclarations(entities)) {
    if (isCommittedEncryptedSecret(decl)) out.set(name, decl);
  }
  return out;
}

/**
 * The `buildRoots` contribution: one entity per committed-encrypted
 * declaration, holding the file's bytes verbatim.
 */
export async function encryptedSecretBuildRoot(ctx: BuildRootContext): Promise<BuildRootContribution> {
  const declarations = committedEncryptedDeclarations(ctx.entities ?? new Map());
  if (declarations.size === 0) return { entities: new Map() };
  return { entities: resolveEncryptedSecrets({ projectRoot: ctx.projectRoot, declarations }) };
}
