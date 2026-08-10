/**
 * Validate the generated lexicon-cedar artifacts.
 *
 * The required-name list below is the surface this package publishes when it
 * generates from its own bundled default schema, which is what `prepack`,
 * `just check-lexicons` and CI all do. It is not a claim about a user's
 * project schema — theirs produces their own names, and `coverage()` is the
 * check that answers whether their schema is fully reachable.
 *
 * Listing them explicitly is the point: `src/generated/` is gitignored, so
 * without this list nothing in the repository records what the default schema
 * is supposed to produce, and a codegen change that quietly dropped every
 * action would still pass "the registry parses".
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

/**
 * Names the default schema must produce: the policy authoring class, one class
 * per entity type, one per action, and the record type beside each.
 */
const REQUIRED_NAMES: string[] = [
  // The authoring surface, present regardless of schema.
  "Policy",

  // Entity types.
  "Application",
  "Document",
  "Folder",
  "Group",
  "ServiceAccount",
  "Team",
  "User",

  // Entity attribute records.
  "ApplicationAttributes",
  "DocumentAttributes",
  "FolderAttributes",
  "GroupAttributes",
  "ServiceAccountAttributes",
  "TeamAttributes",
  "UserAttributes",

  // Actions.
  "AdminAction",
  "ApproveAction",
  "CommentAction",
  "CreateAction",
  "DeleteAction",
  "ListAction",
  "ReadAction",
  "ShareAction",
  "WriteAction",

  // Action context records.
  "AdminContext",
  "ApproveContext",
  "CommentContext",
  "CreateContext",
  "DeleteContext",
  "ListContext",
  "ReadContext",
  "ShareContext",
  "WriteContext",
];

/** Exposed so tests can assert the list stays above the tier-3 bar. */
export const requiredNames: readonly string[] = REQUIRED_NAMES;

/**
 * Validate the generated lexicon-cedar artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-cedar.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
