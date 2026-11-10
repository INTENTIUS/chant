/**
 * Who runs a command, when the caller names nobody (#4911): the forge's
 * actor in a job (`GITHUB_ACTOR`, which Forgejo sets too, then
 * `GITLAB_USER_LOGIN`), else the login (`USER`, `USERNAME` on Windows).
 * The terraform and pulumi lexicons' gated requests and the products'
 * requesters read it here rather than each writing the order, and so do
 * chant's own CLI handlers and the records they write (#4952). A caller
 * that refuses when nobody is named passes `""` as the fallback.
 */

/** The actor fallback's variables, in the order {@link actorFromEnv} reads them. */
export const ACTOR_ENV_ORDER = ["GITHUB_ACTOR", "GITLAB_USER_LOGIN", "USER", "USERNAME"] as const;

/** The first of {@link ACTOR_ENV_ORDER} set to something other than blanks, else `fallback` (default `unknown`). */
export function actorFromEnv(env: Record<string, string | undefined> = process.env, fallback = "unknown"): string {
  for (const name of ACTOR_ENV_ORDER) {
    const v = env[name]?.trim();
    if (v) return v;
  }
  return fallback;
}
