/**
 * `evidence` of an Op waves spec (#4870), checked with no import, so the
 * spec's readers in the bundles stay small. The runner side is
 * ./op-waves-evidence.ts.
 */

/** `evidence` of an Op waves spec (#4870). */
export interface OpWavesEvidence {
  /** The checks whose current evidence the applied commit needs, read at base. */
  requires?: string[];
}

/** What is wrong with a spec's `evidence`, empty when nothing is. */
export function opWavesEvidenceProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return ["`evidence` must be an object"];
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(r)) if (key !== "requires") problems.push(`\`evidence.${key}\` is not a setting; \`evidence\` takes \`requires\``);
  if (r.requires !== undefined && (!Array.isArray(r.requires) || r.requires.some((c) => typeof c !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(c)))) {
    problems.push("`evidence.requires` must be a list of check names (letters, digits, `.`, `_`, `:` and `-`, as `refs` in .chant/trust.json names them)");
  }
  return problems;
}
