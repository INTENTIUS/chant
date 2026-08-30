/**
 * Shared helper for the committed-encrypted secret checks: join each
 * `declareSecret({ provenance: "committed-encrypted" })` in the entity map to
 * the sidecar file the build emitted for it.
 *
 * The join has to go through `output.files`, not `getPrimaryOutput`. The
 * ciphertext is deliberately kept OUT of the primary output — that is what
 * makes applying an undecrypted Secret structurally impossible — so a check
 * that reads only the primary output sees nothing at all here.
 *
 * Excluded from check auto-discovery by the "helper" filename filter.
 */
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { CommittedEncryptedSecretDeclaration } from "@intentius/chant/secret-provenance";
import { getAdditionalFiles } from "./k8s-helpers";
import { committedEncryptedDeclarations, sidecarFilename, validateEncryptedSecretDocument, type EncryptedSecretDocument } from "../../sops/encrypted-secret-file";

/** One committed-encrypted declaration, joined to what the build emitted for it. */
export interface ResolvedEncryptedSecret {
  /** The entity-map key the declaration was discovered under. */
  entityName: string;
  declaration: CommittedEncryptedSecretDeclaration;
  /** The sidecar filename the declaration's path maps to. */
  filename: string;
  /** Undefined when the build emitted no such sidecar — the file did not resolve. */
  text?: string;
  /** Everything wrong with the emitted document. Empty when it is clean. */
  problems: string[];
  /** Parsed structure, when the document parsed at all. */
  document?: EncryptedSecretDocument;
}

/** Every sidecar file across every lexicon output, keyed by filename. */
export function allAdditionalFiles(ctx: PostSynthContext): Map<string, string> {
  const files = new Map<string, string>();
  for (const [, output] of ctx.outputs) {
    for (const [filename, content] of Object.entries(getAdditionalFiles(output))) {
      files.set(filename, content);
    }
  }
  return files;
}

/**
 * Join every committed-encrypted declaration to its emitted sidecar,
 * validating the document as it goes. A declaration with no sidecar comes
 * back with `text` undefined and one problem naming the missing file.
 */
export function resolveEncryptedSecretClaims(ctx: PostSynthContext): ResolvedEncryptedSecret[] {
  const declarations = committedEncryptedDeclarations(ctx.entities);
  if (declarations.size === 0) return [];

  const files = allAdditionalFiles(ctx);
  const resolved: ResolvedEncryptedSecret[] = [];

  for (const [entityName, declaration] of declarations) {
    const filename = sidecarFilename(declaration.file);
    const text = files.get(filename);
    if (text === undefined) {
      resolved.push({
        entityName,
        declaration,
        filename,
        problems: [
          `the build emitted no file for "${declaration.file}" — ` +
            `the declared ciphertext did not resolve`,
        ],
      });
      continue;
    }
    const { problems, document } = validateEncryptedSecretDocument(text, declaration);
    resolved.push({ entityName, declaration, filename, text, problems, document });
  }

  return resolved;
}
