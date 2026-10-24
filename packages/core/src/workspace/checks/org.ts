/**
 * Org scope (#3168): members of kind `repo`, which name another repository's
 * workspace by URL and pinned revision, and the org-level workspace that
 * holds only such members.
 *
 * | Id | Check |
 * |---|---|
 * | WSP013 | an org workspace holds only repo members |
 * | WSP014 | every repository the forge lists is declared (with `--forge-repos`) |
 * | WSP015 | every declared repository is one the forge lists (with `--forge-repos`) |
 * | WSP016 | no repo member's URL carries a password or token |
 *
 * The forge's list is input, never fetched here: a warden enumerates the
 * org's repositories from its own API and hands the list to
 * `chant workspace check --forge-repos <file>`, so the check stays offline.
 */

import { isAbsolute, resolve } from "node:path";
import { REPO_KIND } from "../kinds";
import type { WorkspaceCheck, WorkspaceDiagnostic } from "../checks";

/** One repository the forge lists. */
export interface ForgeRepo {
  url: string;
  /** An archived repository need not be declared, and declaring one is not a drop. */
  archived: boolean;
}

/** The forge's repository list for `--forge-repos` (#3168), as a warden writes it. */
export interface ForgeRepoList {
  /** The file it was read from, for messages. */
  source: string;
  repos: ForgeRepo[];
}

/**
 * Parse a forge repository list. Three shapes are read: `{ "repos": [...] }`
 * (a warden may add `forge` and `org` beside it), a bare array, and, for each
 * repository, a URL string or `{ "url", "archived"? }`. Throws an Error that
 * says what is wrong.
 */
export function parseForgeRepos(text: string, source: string): ForgeRepoList {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not JSON (${(err as Error).message})`);
  }
  const list = Array.isArray(raw) ? raw : raw !== null && typeof raw === "object" && Array.isArray((raw as { repos?: unknown }).repos) ? (raw as { repos: unknown[] }).repos : undefined;
  if (!list) throw new Error(`${source} is neither an array of repositories nor an object with a repos array`);
  const repos = list.map((r, i): ForgeRepo => {
    if (typeof r === "string" && r.length > 0) return { url: r, archived: false };
    if (r !== null && typeof r === "object" && typeof (r as { url?: unknown }).url === "string") {
      return { url: (r as { url: string }).url, archived: (r as { archived?: unknown }).archived === true };
    }
    throw new Error(`${source}: repos[${i}] is neither a URL nor an object with a url`);
  });
  return { source, repos };
}

/**
 * A repository URL reduced to what names the repository, so the forge's
 * https URL and a declaration's ssh or scp-style URL compare equal:
 * `host/owner/repo`, lowercased, with no scheme, user, port, `.git` or
 * trailing slash. A local path or file URL becomes its absolute path,
 * resolved from `base`.
 */
export function repoKey(url: string, base: string = process.cwd()): string {
  const trimmed = url.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(trimmed);
  let hostPath: string | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let u: URL;
    try {
      u = new URL(trimmed);
    } catch {
      return trimmed.toLowerCase();
    }
    if (u.protocol === "file:") return stripGit(decodeURIComponent(u.pathname));
    hostPath = `${u.hostname}${u.pathname}`;
  } else if (scp && !isAbsolute(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)) {
    hostPath = `${scp[1]}/${scp[2]}`;
  } else {
    return stripGit(resolve(base, trimmed));
  }
  return stripGit(hostPath.replace(/\/+/g, "/")).toLowerCase();
}

function stripGit(path: string): string {
  return path.replace(/\/+$/, "").replace(/\.git$/, "");
}

/** Whether a URL carries a password or token, which a declaration must never hold. */
export function urlCredential(url: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    // ssh://git@host is a user name, not a secret; a password, or any user on http(s), is one.
    return u.password !== "" || (u.username !== "" && /^https?:$/.test(u.protocol));
  } catch {
    return false;
  }
}

const repoMembers = (ctx: Parameters<WorkspaceCheck["check"]>[0]) => ctx.declaration.members.filter((m) => m.kind === REPO_KIND && m.repo !== null);

function finding(check: WorkspaceCheck, message: string, pointer: string, entity?: string): WorkspaceDiagnostic {
  return { checkId: check.id, severity: check.severity, message, pointer, ...(entity !== undefined ? { entity } : {}) };
}

export const ORG_CHECKS: readonly WorkspaceCheck[] = [
  {
    id: "WSP013",
    name: "org-member-local",
    description: "An org workspace (scope org) holds only members of kind repo, each a reference to another repository's workspace (#3168).",
    severity: "error",
    configurable: false,
    check(ctx) {
      if (ctx.declaration.scope !== "org") return [];
      return ctx.declaration.entries
        .filter((e) => e.kind !== REPO_KIND)
        .map((e) =>
          finding(this, `${e.type === "group" ? "example group" : "member"} ${e.name} is kind ${e.kind}, and an org workspace holds only repo members; move it into a repository's own workspace and reference that`, `${e.pointer}/kind`, e.name),
        );
    },
  },
  {
    id: "WSP014",
    name: "org-repo-undeclared",
    description: "With --forge-repos, every repository the forge lists, archived ones aside, is named by a repo member (#3168).",
    severity: "error",
    configurable: true,
    check(ctx) {
      const forge = ctx.facts?.forgeRepos;
      if (!forge) return [];
      const declared = new Set(repoMembers(ctx).map((m) => repoKey(m.repo!.url)));
      return forge.repos
        .filter((r) => !r.archived && !declared.has(repoKey(r.url)))
        .map((r) => finding(this, `the forge lists ${r.url} (${forge.source}), and no repo member names it; add a member of kind repo with its url and pinned rev`, "/members"));
    },
  },
  {
    id: "WSP015",
    name: "org-repo-dropped",
    description: "With --forge-repos, every repository a repo member names is one the forge still lists (#3168).",
    severity: "warning",
    configurable: true,
    check(ctx) {
      const forge = ctx.facts?.forgeRepos;
      if (!forge) return [];
      const listed = new Set(forge.repos.map((r) => repoKey(r.url)));
      return repoMembers(ctx)
        .filter((m) => !listed.has(repoKey(m.repo!.url)))
        .map((m) => finding(this, `member ${m.name} names ${m.repo!.url}, which the forge no longer lists (${forge.source}); remove the member or say why it stays`, `${m.pointer}/repo/url`, m.name));
    },
  },
  {
    id: "WSP016",
    name: "repo-url-credential",
    description: "No repo member's URL carries a password or token: the declaration is committed, and git's own credential helpers supply access (#3168).",
    severity: "error",
    configurable: false,
    check(ctx) {
      return repoMembers(ctx)
        .filter((m) => urlCredential(m.repo!.url))
        .map((m) => finding(this, `member ${m.name}'s repo url carries a credential; name the repository without one and let git's credential helper supply access`, `${m.pointer}/repo/url`, m.name));
    },
  },
];
