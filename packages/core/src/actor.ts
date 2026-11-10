/**
 * Who runs a command, when the caller names nobody (#4911): the forge's
 * actor in a job (`GITHUB_ACTOR`, which Forgejo sets too, then
 * `GITLAB_USER_LOGIN`), else the login (`USER`, `USERNAME` on Windows).
 * The terraform and pulumi lexicons' gated requests and the products'
 * requesters read it here rather than each writing the order, and so do
 * chant's own CLI handlers and the records they write (#4952). A caller
 * that refuses when nobody is named passes `""` as the fallback.
 *
 * {@link actorOf} is the same order with the two places a product's
 * requester also looks (#4966): `GITHUB_TRIGGERING_ACTOR` ahead of the
 * forge's actor, which names who re-ran a job rather than who started its
 * run, and git's `user.name` in the checkout between the forge's actor and
 * the login, which names the person at a laptop better than `$USER`.
 */

import { spawnSync } from "node:child_process";

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

/** Which of the places {@link actorOf} reads, and the answer when none is set. */
export interface ActorOptions {
  /** The variables. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Read `GITHUB_TRIGGERING_ACTOR` first: who re-ran the job, ahead of who started the run. Default false. */
  triggering?: boolean;
  /** Read the forge's actor (`GITHUB_ACTOR`, `GITLAB_USER_LOGIN`). Default true. */
  forge?: boolean;
  /** A checkout whose git config is read after the forge's actor. Unset, git is not asked. */
  repo?: string;
  /** The git config keys read in `repo`, in order. Default `["user.name"]`. */
  gitKeys?: readonly string[];
  /** Read the login (`USER`, `USERNAME`) last. Default true. */
  login?: boolean;
  /** The answer when nothing is set. Default `unknown`; `""` for a caller that refuses. */
  fallback?: string;
}

/** The places {@link actorOf} reads for `options`, in order: variable names, and `git:<key>` for a git config key. */
export function actorOrder(options: Omit<ActorOptions, "env" | "fallback"> = {}): string[] {
  return [
    ...(options.triggering ? ["GITHUB_TRIGGERING_ACTOR"] : []),
    ...(options.forge === false ? [] : ["GITHUB_ACTOR", "GITLAB_USER_LOGIN"]),
    ...(options.repo !== undefined ? (options.gitKeys ?? ["user.name"]).map((k) => `git:${k}`) : []),
    ...(options.login === false ? [] : ["USER", "USERNAME"]),
  ];
}

function gitConfig(repo: string, key: string): string | undefined {
  const r = spawnSync("git", ["-C", repo, "config", key], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/**
 * The first place of {@link actorOrder} set to something other than blanks,
 * else `fallback` (#4966). With no options it answers as
 * {@link actorFromEnv}. A git config key is read only when every place
 * before it is empty, so a job with a forge actor runs no git.
 */
export function actorOf(options: ActorOptions = {}): string {
  const env = options.env ?? process.env;
  for (const place of actorOrder(options)) {
    const v = (place.startsWith("git:") ? gitConfig(options.repo!, place.slice(4)) : env[place])?.trim();
    if (v) return v;
  }
  return options.fallback ?? "unknown";
}

export { ACTOR_ORDER_FLOOR } from "./release-floors";
