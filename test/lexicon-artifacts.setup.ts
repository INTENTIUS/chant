import { findMissingLexiconArtifacts, formatMissingArtifacts } from "./lexicon-artifacts";

/**
 * Vitest globalSetup (chant #1419). Fails the run before any test file
 * loads when a lexicon's generated artifacts are absent, with one message
 * naming the lexicons and the command, instead of scattered module-not-found
 * and assertion failures. Generation itself takes ~55s cold so it is not run
 * here; `just test` does that through `_ensure-gen`.
 */
export default function setup(): void {
  if (process.env.CHANT_SKIP_ARTIFACT_CHECK) return;
  const found = findMissingLexiconArtifacts(process.cwd());
  if (found.length === 0) return;
  throw new Error(`\n${formatMissingArtifacts(found)}\n`);
}
