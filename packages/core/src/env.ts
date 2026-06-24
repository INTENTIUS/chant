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
 * any name is accepted).
 */
export function unknownEnvError(requested: string | undefined, declared: string[] | undefined): string | undefined {
  if (!requested || !declared || declared.length === 0) return undefined;
  if (declared.includes(requested)) return undefined;
  return `Unknown environment "${requested}". Declared environments: ${declared.join(", ")}.`;
}
