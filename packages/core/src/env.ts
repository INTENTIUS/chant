/**
 * Active environment for a chant run (#505).
 *
 * `chant graph --env prod` / `chant build --env prod` set {@link ENV_VAR} before
 * the project is discovered, so env-aware source can branch on it — producing an
 * environment-specific graph (or build). Environments in chant are **build-context
 * switches**, not a resource filter: there is no per-node env membership, so an
 * "env view" comes from *re-evaluating* the project under the environment, exactly
 * as a deploy of that environment would. Author env-aware source by branching on
 * {@link env}:
 *
 * ```ts
 * import { env } from "@intentius/chant";
 * const replicas = env() === "prod" ? 5 : 1;
 * ```
 *
 * Run `chant graph --env prod` and `chant graph --env dev` to get the two graphs;
 * pinhole renders/diffs them to show environment drift (INTENTIUS/pinhole#3).
 */

import { environmentNames, matchesDeclaredEnvironment, type EnvironmentDeclaration } from "./config";

/** The environment variable the CLI sets from `--env`. */
export const ENV_VAR = "CHANT_ENV";

/** The active environment for this run (from `--env`), or `fallback` if none. */
export function env(fallback?: string): string | undefined {
  return process.env[ENV_VAR] ?? fallback;
}

/**
 * Validate a requested environment against the project's declared `environments`
 * (`chant.config`). Returns an error message for an unknown env, or `undefined`
 * when it's valid (or when the project declares no environments, in which case
 * any name is accepted). `declared` entries may be a bare name or `{ name,
 * endpoint }` (#1166) — {@link environmentNames} reduces either to the names
 * this checks against. An entry containing `*` is a glob pattern (#1221):
 * `"pr-*"` legalizes every `pr-<n>` environment. Literal entries are checked
 * first, then patterns — see {@link matchesDeclaredEnvironment}.
 */
export function unknownEnvError(
  requested: string | undefined,
  declared: EnvironmentDeclaration[] | undefined,
): string | undefined {
  if (!requested || !declared || declared.length === 0) return undefined;
  if (matchesDeclaredEnvironment(declared, requested)) return undefined;
  const names = environmentNames(declared) ?? [];
  return `Unknown environment "${requested}". Declared environments: ${names.join(", ")}.`;
}

/**
 * True when an environment name looks like production — `prod`, `production`,
 * and separator-delimited variants (`prod-eu`, `us-prod`, `production2`).
 * `chant lifecycle teardown <env> --yes` demands an extra confirmation for
 * these (#1222): a typo that survives the declared-environments check should
 * still not delete production on one flag. Name-shaped, deliberately — chant
 * has no other signal for which environment is the one that pays the bills.
 */
export function isProdLikeEnvironment(name: string): boolean {
  return /(^|[-_./])prod(uction)?([-_./0-9]|$)/i.test(name);
}
