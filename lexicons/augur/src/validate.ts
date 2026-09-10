/**
 * Validate generated lexicon-augur artifacts.
 *
 * Thin wrapper around the core validation framework, with augur's
 * configuration.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

/**
 * Empty, and correct empty. `requiredNames` names generated resource classes
 * that must survive a regenerate, and this lexicon generates none:
 * `codegen/generate.ts` writes `lexicon-augur.json` as `{}` on purpose, because
 * augur's subject is the request shape rather than a substrate's schema, and
 * its one resource is hand-written. There is no name to require, so the list
 * stays empty and the remaining checks — the artifacts exist, the registry
 * parses, the surface snapshot — are what validate proves here.
 */
const REQUIRED_NAMES: string[] = [];

/** Validate the generated lexicon-augur artifacts. */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-augur.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
