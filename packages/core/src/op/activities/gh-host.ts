/**
 * The host a `gh` call that names none should go to (#3780).
 *
 * `gh pr create`, `gh pr view`, `gh label create` and `gh issue create` take
 * neither a URL nor a host. Outside a checkout they go to github.com; inside
 * one, `gh` matches the git remotes against the hosts it knows, which in a CI
 * job is github.com alone, so a GitHub Enterprise Server or Forgejo remote is
 * not taken for a GitHub host at all. `GH_HOST` names the host for those calls,
 * and `gh` then reads `GH_ENTERPRISE_TOKEN` for it rather than `GH_TOKEN`
 * (#2333), so the job's token is copied across when the job set only that.
 *
 * The host is the job's forge when the run is a GitHub Actions or Forgejo
 * Actions job (`GITHUB_SERVER_URL`, `FORGEJO_SERVER_URL` first), else the
 * `origin` remote's. github.com, or a host nothing names, leaves the
 * environment as it was, so github.com runs are unchanged. A `GH_HOST` already
 * set is the caller's choice and is kept.
 *
 * `gh pr` speaks GraphQL, which Forgejo does not serve, so on Forgejo this
 * makes those calls reach the right instance and fail there by name rather
 * than on github.com.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Env = Record<string, string | undefined>;

/** The host of a git remote URL: `https://host/o/r`, `ssh://git@host:22/o/r`, or `git@host:o/r`. */
export function remoteHost(url: string | undefined): string | undefined {
  const u = url?.trim();
  if (!u) return undefined;
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/)/.exec(u);
  if (scp) return scp[1].toLowerCase();
  try {
    const parsed = new URL(u);
    // An ssh port is not part of the host gh knows; an http(s) one is.
    return (parsed.protocol === "ssh:" ? parsed.hostname : parsed.host).toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** The forge host a CI job names, or undefined outside a GitHub Actions or Forgejo Actions job. */
function jobHost(env: Env): string | undefined {
  return remoteHost(env.FORGEJO_SERVER_URL) ?? remoteHost(env.GITHUB_SERVER_URL);
}

/**
 * `env` with `GH_HOST` set to `host` when it is not github.com, and
 * `GH_ENTERPRISE_TOKEN` set from `GH_TOKEN` or `GITHUB_TOKEN` when neither
 * enterprise variable is. Pure, for tests and for callers that know the host.
 */
export function ghEnvForHost<E extends Env>(env: E, host: string | undefined): E {
  if (env.GH_HOST?.trim() || !host || host === "github.com") return env;
  const out: Env = { ...env, GH_HOST: host };
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (token && !env.GH_ENTERPRISE_TOKEN?.trim() && !env.GITHUB_ENTERPRISE_TOKEN?.trim()) out.GH_ENTERPRISE_TOKEN = token;
  return out as E;
}

/**
 * The environment to run a host-less `gh` call with: {@link ghEnvForHost}
 * for the job's forge, or for `origin`'s host in `cwd` outside a CI job.
 */
export async function ghHostEnv(env: NodeJS.ProcessEnv = process.env, cwd?: string): Promise<NodeJS.ProcessEnv> {
  if (env.GH_HOST?.trim()) return env;
  let host = jobHost(env);
  if (!host) {
    try {
      const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], cwd ? { cwd } : {});
      host = remoteHost(stdout);
    } catch {
      host = undefined;
    }
  }
  return ghEnvForHost(env, host);
}
