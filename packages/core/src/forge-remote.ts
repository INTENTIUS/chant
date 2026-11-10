/**
 * The forge a checkout's origin remote names (#4920): its kind, host, web
 * origin and repository, for a command run on a laptop with no CI variables
 * and no repository setting, such as plywood's `cancel`.
 *
 * It is the reading chant's own laptop paths make when the environment
 * names no forge (`forgeWorkReader` in ./workspace/forge-work.ts): the
 * host from the remote's URL, the kind from the host's name, and the
 * repository path. Kept out of `pr-forge.ts`, which is in the pr-forge and
 * pr-loop bundles.
 */

import { execFileSync } from "node:child_process";
import type { ForgeKind } from "./pr-forge";
import { remoteRepoPath } from "./op/activities/forge-pull-request";
import { remoteHost } from "./op/activities/gh-host";

export { remoteRepoPath, remoteHost };

/** The forge kind a remote host is: github.com and hosts named for GitHub, GitLab, or Forgejo and Gitea (codeberg.org too). Null for any other. */
export function forgeKindOfHost(host: string): ForgeKind | null {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (h === "github.com" || /(^|[.-])github([.-]|$)/.test(h)) return "github";
  if (h === "gitlab.com" || /(^|[.-])gitlab([.-]|$)/.test(h)) return "gitlab";
  if (h === "codeberg.org" || /(^|[.-])(forgejo|gitea)([.-]|$)/.test(h)) return "forgejo";
  return null;
}

/** The forge a git remote names. */
export interface RemoteForge {
  kind: ForgeKind;
  /** Lower-cased, with an http(s) remote's port. */
  host: string;
  /** The web origin, `https://host` (an http remote keeps its scheme and port), as `--url` takes it. */
  url: string;
  /** `owner/name`, or a GitLab group path and name. */
  repo: string;
}

/**
 * The forge a remote URL names (`https://host/o/r.git`, `ssh://git@host/o/r`,
 * `git@host:o/r`), or undefined when it names no repository path or its host
 * is none {@link forgeKindOfHost} knows. `kind` stands in for the host's
 * guess, for a self-hosted forge whose name says nothing.
 */
export function forgeOfRemote(remoteUrl: string | undefined, opts: { kind?: ForgeKind } = {}): RemoteForge | undefined {
  const host = remoteHost(remoteUrl);
  const repo = remoteRepoPath(remoteUrl);
  if (!host || !repo) return undefined;
  const kind = opts.kind ?? forgeKindOfHost(host);
  if (!kind) return undefined;
  let url = `https://${host.replace(/:\d+$/, "")}`;
  try {
    const u = new URL(remoteUrl!.trim());
    if (u.protocol === "http:" || u.protocol === "https:") url = `${u.protocol}//${u.host.toLowerCase()}`;
  } catch {
    // An scp-style remote is ssh, whose port is not the web's.
  }
  return { kind, host, url, repo };
}

/** `git remote get-url <remote>` in `cwd`, or undefined when there is none. */
function gitRemoteUrl(cwd: string, remote: string): string | undefined {
  try {
    return execFileSync("git", ["remote", "get-url", remote], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The forge the checkout at `cwd` names by its `origin` remote (or
 * `remote`), as {@link forgeOfRemote} reads it. Undefined outside a
 * checkout, with no such remote, or for a host no forge kind is known for.
 */
export function forgeOfCheckout(cwd: string, opts: { remote?: string; kind?: ForgeKind; remoteUrl?: (cwd: string, remote: string) => string | undefined } = {}): RemoteForge | undefined {
  const url = (opts.remoteUrl ?? gitRemoteUrl)(cwd, opts.remote ?? "origin");
  return forgeOfRemote(url, opts.kind ? { kind: opts.kind } : {});
}
