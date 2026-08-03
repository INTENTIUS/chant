/**
 * The config namespace a lexicon owns (#1344).
 *
 * Three lexicons read a top-level `chant.config.ts` key named after themselves —
 * `k8s.profiles.<env>.context`, `temporal.profiles`, `forgejo.runnerLabels` and
 * `forgejo.actionsRoot` — all documented for users, none declared anywhere.
 * `ChantConfigSchema` is `.passthrough()`, so at runtime any key is accepted and
 * a typo is silently ignored: write `runnerLabel` and the Forgejo dialect just
 * uses its defaults, with nothing said. The `ChantConfig` interface is closed,
 * so the documented forgejo example did not even compile:
 *
 *     error TS2353: Object literal may only specify known properties,
 *     and 'forgejo' does not exist in type 'ChantConfig'.
 *
 * Three lexicons had arrived at three different workarounds: temporal exported
 * its own widened `TemporalChantConfig`, k8s's docs dropped `satisfies`, and
 * forgejo's kept it and were wrong.
 *
 * A lexicon now declares the shape of its namespace. The declaration is both
 * halves of the fix at once: core validates against it at load, and the lexicon
 * derives the type it augments `ChantConfig` with from the same schema, so the
 * runtime rule and the compile-time one cannot disagree.
 */

import type { ZodObject, ZodRawShape } from "zod";
import type { ChantConfig } from "./config";

/**
 * A lexicon's config schema. A `ZodObject` specifically, so core can apply
 * `.strict()` itself rather than trusting each lexicon to remember — an unknown
 * key at the top of a declared namespace is a typo, and silently ignoring it is
 * the behavior this replaces.
 *
 * Nested objects are the lexicon's own responsibility: author them with
 * `z.strictObject` so a typo in `k8s.profiles.prod.contxt` fails too. `.strict()`
 * applies to one level.
 */
export type LexiconConfigSchema = ZodObject<ZodRawShape>;

/** What a lexicon needs to expose for its namespace to be validated. */
export interface ConfigOwningLexicon {
  name: string;
  configSchema?: LexiconConfigSchema;
}

export interface LexiconConfigProblem {
  /** The lexicon whose namespace failed. */
  lexicon: string;
  /** Dotted path to the offending value, e.g. `forgejo.runnerLabel`. */
  path: string;
  message: string;
}

/**
 * Validate each lexicon's own namespace against the schema it declares.
 *
 * A lexicon that declares nothing keeps today's passthrough — silence for an
 * unknown key — because tightening a namespace nobody described would fail
 * configs that are working. Declaring is the opt-in.
 *
 * An absent namespace is not a problem: every one of them is optional.
 */
export function validateLexiconConfig(
  lexicons: readonly ConfigOwningLexicon[],
  config: ChantConfig | undefined,
): LexiconConfigProblem[] {
  if (!config) return [];
  const problems: LexiconConfigProblem[] = [];
  const raw = config as unknown as Record<string, unknown>;

  for (const lexicon of lexicons) {
    const schema = lexicon.configSchema;
    if (!schema) continue;
    const value = raw[lexicon.name];
    if (value === undefined) continue;

    const result = schema.strict().safeParse(value);
    if (result.success) continue;

    for (const issue of result.error.issues) {
      const path = [lexicon.name, ...issue.path.map(String)].join(".");
      problems.push({ lexicon: lexicon.name, path, message: issue.message });
    }
  }

  return problems;
}

/** One line per problem, for a CLI error. */
export function formatLexiconConfigProblems(problems: readonly LexiconConfigProblem[]): string {
  return problems.map((p) => `  ${p.path}: ${p.message}`).join("\n");
}
