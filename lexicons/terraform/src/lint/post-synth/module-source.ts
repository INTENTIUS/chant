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
 * `oci` is an OpenTofu `oci://host/repo` source (#3190). OpenTofu selects a
 * version with `?tag=` or `?digest=` (https://opentofu.org/docs/language/modules/sources/),
 * and a source naming neither resolves the `latest` tag. The container-image
 * shapes `repo:tag` and `repo@sha256:...` are read too, so a source written
 * the way `docker pull` spells it is not misread as unpinned. A `:` inside the
 * host (a registry port) is never a tag: only a colon in the last path
 * segment is. The tag and digest rules were checked against the docs page
 * above; the suffix forms are not documented there and are not verified
 * against OpenTofu's parser.
 */

export type ModuleSourceKind = "local" | "registry" | "git" | "oci" | "other";

export interface ModuleSourceClassification {
  kind: ModuleSourceKind;
  /** The `?ref=`/`&ref=` value (falling back to `rev`), when `kind` is `"git"`. */
  ref?: string;
  /** The tag an `oci://` source names, from `?tag=` or a `:tag` suffix on the repository. */
  tag?: string;
  /** The digest an `oci://` source names, from `?digest=` or an `@sha256:...` suffix. */
  digest?: string;
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

function classifyOci(base: string, query: string): ModuleSourceClassification {
  const params = parseQuery(query);
  let path = stripSubdir(base).replace(/^oci:\/\//i, "");
  let tag = params.get("tag") || undefined;
  let digest = params.get("digest") || undefined;

  const at = path.indexOf("@");
  if (at !== -1) {
    digest = digest ?? (path.slice(at + 1) || undefined);
    path = path.slice(0, at);
  }
  const lastSlash = path.lastIndexOf("/");
  const colon = path.indexOf(":", lastSlash + 1); // a port sits before the first slash
  if (colon !== -1) {
    tag = tag ?? (path.slice(colon + 1) || undefined);
  }
  return { kind: "oci", ...(tag !== undefined ? { tag } : {}), ...(digest !== undefined ? { digest } : {}) };
}

export function classifyModuleSource(source: string): ModuleSourceClassification {
  const trimmed = source.trim();
  if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith(".\\") || trimmed.startsWith("..\\")) {
    return { kind: "local" };
  }

  const queryIdx = trimmed.indexOf("?");
  const base = queryIdx === -1 ? trimmed : trimmed.slice(0, queryIdx);
  const query = queryIdx === -1 ? "" : trimmed.slice(queryIdx + 1);

  if (/^oci:\/\//i.test(base)) return classifyOci(base, query);

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

const MUTABLE_TAGS = new Set(["latest", "main", "master", "develop", "dev", "stable", "edge", "nightly"]);

/**
 * Is `tag` a name that conventionally moves (`latest`, a branch-like name)
 * rather than an exact version. Used by TF038. A tag is a mutable pointer in
 * most registries whatever it looks like, so the rule is a warning and this
 * only decides what reads as obviously floating.
 */
export function isMutableOciTag(tag: string): boolean {
  return MUTABLE_TAGS.has(tag.toLowerCase());
}

/**
 * Is a registry `version` constraint an exact version (`1.4.0`, `= 1.4.0`,
 * `=1.4.0`) rather than a range (`~> 1.4`, `>= 1.4`, `>= 1.0, < 2.0`). Used
 * by TF039. A bare version is an exact constraint in Terraform.
 */
export function isExactVersionConstraint(version: string): boolean {
  return /^(?:=\s*)?v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version.trim()) && !version.includes(",");
}
