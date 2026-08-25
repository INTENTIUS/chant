/**
 * The committed-ciphertext entity: marker, shape and type guard only.
 *
 * Split from `./encrypted-secret-file.ts` so the serializer can recognise the
 * entity without pulling `node:fs` and a YAML parser into its module graph —
 * the resolution stage needs both, the emission stage needs neither.
 *
 * Not exported from the package entry point and not constructible by an
 * author: the authored surface is `declareSecret({ provenance:
 * "committed-encrypted", file })`. A public entity taking inline bytes is
 * exactly what this design exists to prevent.
 */
import { basename } from "node:path";
import type { Declarable } from "@intentius/chant/declarable";

/** Marks an entity whose bytes are committed ciphertext, emitted verbatim. */
export const ENCRYPTED_SECRET_FILE_MARKER = Symbol.for("chant.k8s.encryptedSecretFile");

/**
 * The entity's type name. Deliberately outside the `K8s::{Group}::{Kind}`
 * surface a real Secret speaks: an observer must NOT read this against a live
 * cluster — the ciphertext is not the thing in the cluster, the decrypted
 * Secret is — so a type with no generated operation surface, reporting the
 * honest NOT-OBSERVED, is the right answer.
 */
export const ENCRYPTED_SECRET_FILE_TYPE = "K8s::Sops::EncryptedSecretFile";

/** Entity-map key prefix, colon-separated so it cannot collide with a TS export name. */
export const ENCRYPTED_SECRET_ENTITY_PREFIX = "sops:";

export interface EncryptedSecretFileEntity extends Declarable {
  readonly entityType: typeof ENCRYPTED_SECRET_FILE_TYPE;
  readonly [ENCRYPTED_SECRET_FILE_MARKER]: true;
  /** Sidecar filename written beside the primary output. */
  readonly filename: string;
  /** The committed bytes, exactly as read. */
  readonly text: string;
  /** `metadata.name` of the encrypted Secret — equal to the declaration's name. */
  readonly secretName: string;
  /** `metadata.namespace`, cleartext in the file (SOPS encrypts values, not structure). */
  readonly namespace?: string;
  /** The declared repo-relative path, for diagnostics. */
  readonly sourcePath: string;
}

export function isEncryptedSecretFileEntity(entity: Declarable): entity is EncryptedSecretFileEntity {
  return (entity as unknown as Record<symbol, unknown>)[ENCRYPTED_SECRET_FILE_MARKER] === true;
}

/** The sidecar filename a declaration's file is emitted under. */
export function sidecarFilename(file: string): string {
  return basename(file);
}
