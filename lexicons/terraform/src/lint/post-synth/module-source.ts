/**
 * Classify a `module` block's `source` string, shared by TF004 (registry
 * module without a version) and TF005 (git/hg module unpinned or pinned to
 * a branch). Neither rule evaluates HCL: both read `source` as the literal
 * string hcl2json hands back, so a source built from a variable or a
 * function call is never classified (`"other"`), matching tflint's own
 * `SourceKnown` guard on `module.Source`.
 *
 * `registry` mirrors `hashicorp/terraform-registry-address`'s
 * `ParseModuleSource` (MPL-2.0,
 * https://github.com/hashicorp/terraform-registry-address/blob/main/module.go):
 * three slash-separated parts (`namespace/name/target-system`), or four with
 * a leading hostname that contains a dot and is not `github.com` or
 * `bitbucket.org` (those are reserved for direct VCS installs, never a
 * registry). `git` covers the sources tflint's `terraform_module_pinned_source`
 * treats as git/hg: an explicit `git::`/`hg::` force prefix, the `github.com`
 * and `bitbucket.org` shorthands its `GitHubDetector`/`BitBucketDetector`
 * recognize, scp-style `git@host:path` addresses, and any source ending in
 * `.git`. `local` is `./` or `../` (checkov's `UNKNOWN` case for module
 * pinning: a local path cannot be pinned to anything and is never flagged).
 */

export type ModuleSourceKind = "local" | "registry" | "git" | "other";

export interface ModuleSourceClassification {
  kind: ModuleSourceKind;
  /** The `?ref=`/`&ref=` value (falling back to `rev`), when `kind` is `"git"`. */
  ref?: string;
}

const REGISTRY_NAME = /^[0-9A-Za-z](?:[0-9A-Za-z_-]{0,62}[0-9A-Za-z])?$/;
const REGISTRY_TARGET_SYSTEM = /^[0-9a-z]{1,64}$/;
const RESERVED_VCS_HOSTS = new Set(["github.com", "bitbucket.org"]);

/** Split a raw query string (no leading `?`) into its key/value pairs, last write wins. */
function parseQuery(query: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1));
    params.set(decodeURIComponent(key), value);
  }
  return params;
}

/** Strip a `//<subdir>` package-subdirectory suffix, ignoring one embedded in the scheme (`https://`). */
function stripSubdir(base: string): string {
  const schemeEnd = base.indexOf("://");
  const searchFrom = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const idx = base.indexOf("//", searchFrom);
  return idx === -1 ? base : base.slice(0, idx);
}

function isRegistryAddress(rest: string): boolean {
  const parts = stripSubdir(rest).split("/");
  let namespace: string, name: string, targetSystem: string;
  if (parts.length === 3) {
    [namespace, name, targetSystem] = parts;
  } else if (parts.length === 4) {
    const host = parts[0];
    if (!host.includes(".") || RESERVED_VCS_HOSTS.has(host.toLowerCase())) return false;
    [, namespace, name, targetSystem] = parts;
  } else {
    return false;
  }
  return REGISTRY_NAME.test(namespace) && REGISTRY_NAME.test(name) && REGISTRY_TARGET_SYSTEM.test(targetSystem);
}

/** Is `rest` (source with any `git::`/`hg::` force prefix already stripped) a git/hg-shaped source? */
function isGitShaped(rest: string): boolean {
  if (/^[\w.-]+@[^:/]+:/.test(rest)) return true; // scp-style, e.g. git@github.com:org/repo.git
  const withoutScheme = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (/^(github\.com|bitbucket\.org)\//i.test(withoutScheme)) return true;
  if (/\.git($|[/?])/i.test(withoutScheme)) return true;
  return false;
}

export function classifyModuleSource(source: string): ModuleSourceClassification {
  const trimmed = source.trim();
  if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith(".\\") || trimmed.startsWith("..\\")) {
    return { kind: "local" };
  }

  const queryIdx = trimmed.indexOf("?");
  const base = queryIdx === -1 ? trimmed : trimmed.slice(0, queryIdx);
  const query = queryIdx === -1 ? "" : trimmed.slice(queryIdx + 1);

  const forced = /^(git|hg)::/i.exec(base);
  const rest = forced ? base.slice(forced[0].length) : base;

  if (forced || isGitShaped(rest)) {
    const params = parseQuery(query);
    const ref = params.get("ref") || params.get("rev") || undefined;
    return { kind: "git", ref };
  }

  if (isRegistryAddress(rest)) return { kind: "registry" };

  return { kind: "other" };
}

const TAG_LIKE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

/**
 * Is `ref` pinned tightly enough for TF005: a semver-shaped tag or a full
 * 40-hex commit SHA. Stricter than checkov's `CKV_TF_1`/`CKV_TF_2`, which
 * accept any `?ref=` containing `\d\.\d` (so `v1.2-dev` passes there); the
 * page documents the difference.
 */
export function isPinnedRef(ref: string): boolean {
  return TAG_LIKE.test(ref) || FULL_SHA.test(ref);
}

/** Is `ref` one of the well-known mutable branch names tflint's `flexible` style rejects, plus `trunk`. */
export function isDefaultBranch(ref: string): boolean {
  return DEFAULT_BRANCHES.has(ref);
}
