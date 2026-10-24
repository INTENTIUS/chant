/**
 * Forgejo `uses:` action-reference resolver.
 *
 * GitHub Actions resolves a bare `uses: actions/checkout@v4` against the GitHub
 * Marketplace. Forgejo / Codeberg / Gitea runners have no Marketplace, so such a
 * ref must be rewritten to a form their runner can fetch — a full repository URL,
 * or a path under a configured actions root that mirrors the action.
 *
 * The resolver rewrites a built-in set of common actions and reports anything it
 * can't place as a diagnostic (never dropping or silently passing it through).
 */

import { pinAtMajor, pinMajor } from "@intentius/chant/action-pins";

/**
 * Default actions root. `code.forgejo.org` hosts the Forgejo `actions/*` mirror
 * (checkout, setup-*, cache, upload/download-artifact, …). Override per project
 * via `forgejo.actionsRoot` in `chant.config.ts`.
 */
export const DEFAULT_ACTIONS_ROOT = "https://code.forgejo.org";

/**
 * Where a known action resolves:
 *  - `mirror`: `<actionsRoot>/<repo>` — follows the configured actions root.
 *  - `url`:    an absolute base URL — independent of the actions root (used for
 *              actions not carried by the Forgejo mirror, e.g. `docker/*`).
 */
export type ActionTarget =
  | {
      kind: "mirror";
      repo: string;
      /**
       * The newest major version that runs on a Forgejo runner, when an older
       * one is needed: a ref asking for a later major is rewritten to this one.
       */
      newest?: string;
    }
  | { kind: "url"; url: string };

/**
 * `upload-artifact` and `download-artifact` v4 and later use `@actions/artifact`
 * v2, which refuses to run on GitHub Enterprise Server, and a Forgejo runner
 * presents itself to an action as one: the step fails with "@actions/artifact
 * v2.0.0+, upload-artifact@v4+ and download-artifact@v4+ are not currently
 * supported on GHES" (#4008). v3 talks to the artifact service Forgejo serves.
 */
export const FORGEJO_ARTIFACT_VERSION = "v3";

/** Built-in mapping of GitHub action `owner/repo` → Forgejo-resolvable target. */
export const KNOWN_ACTIONS: Record<string, ActionTarget> = {
  // actions/* — mirrored on the Forgejo actions root.
  "actions/checkout": { kind: "mirror", repo: "actions/checkout" },
  "actions/setup-node": { kind: "mirror", repo: "actions/setup-node" },
  "actions/setup-go": { kind: "mirror", repo: "actions/setup-go" },
  "actions/setup-python": { kind: "mirror", repo: "actions/setup-python" },
  "actions/setup-java": { kind: "mirror", repo: "actions/setup-java" },
  "actions/setup-dotnet": { kind: "mirror", repo: "actions/setup-dotnet" },
  "actions/cache": { kind: "mirror", repo: "actions/cache" },
  "actions/upload-artifact": { kind: "mirror", repo: "actions/upload-artifact", newest: FORGEJO_ARTIFACT_VERSION },
  "actions/download-artifact": { kind: "mirror", repo: "actions/download-artifact", newest: FORGEJO_ARTIFACT_VERSION },
  // docker/* — not on the Forgejo mirror; pin to the full GitHub URL, which
  // Forgejo runners can fetch directly.
  "docker/build-push-action": { kind: "url", url: "https://github.com/docker/build-push-action" },
  "docker/login-action": { kind: "url", url: "https://github.com/docker/login-action" },
  "docker/setup-buildx-action": { kind: "url", url: "https://github.com/docker/setup-buildx-action" },
  "docker/setup-qemu-action": { kind: "url", url: "https://github.com/docker/setup-qemu-action" },
  "docker/metadata-action": { kind: "url", url: "https://github.com/docker/metadata-action" },
};

export interface ActionResolveOptions {
  /** Base for `mirror` targets; defaults to {@link DEFAULT_ACTIONS_ROOT}. */
  actionsRoot?: string;
  /** Mapping table to use; defaults to {@link KNOWN_ACTIONS}. */
  known?: Record<string, ActionTarget>;
}

export interface ActionResolveResult {
  /** The rewritten (or unchanged) `uses:` ref. */
  rewritten: string;
  /** Set when the ref could not be resolved — surfaced as a build warning. */
  warning?: string;
}

/** A ref that already resolves on Forgejo as-is needs no rewrite and no warning. */
function isAlreadyResolvable(ref: string): boolean {
  return (
    ref.startsWith("./") ||
    ref.startsWith("../") ||
    ref.startsWith(".\\") ||
    ref.startsWith("docker://") ||
    /^https?:\/\//.test(ref)
  );
}

/**
 * Resolve a single `uses:` action ref to a Forgejo-resolvable form.
 */
export function resolveActionRef(ref: string, options: ActionResolveOptions = {}): ActionResolveResult {
  const trimmed = ref.trim();
  if (trimmed === "" || isAlreadyResolvable(trimmed)) return { rewritten: ref };

  const root = (options.actionsRoot ?? DEFAULT_ACTIONS_ROOT).replace(/\/+$/, "");
  const known = options.known ?? KNOWN_ACTIONS;

  const atIndex = trimmed.lastIndexOf("@");
  const path = atIndex >= 0 ? trimmed.slice(0, atIndex) : trimmed;
  const version = atIndex >= 0 ? trimmed.slice(atIndex + 1) : "";

  const segments = path.split("/");
  if (segments.length < 2) {
    return { rewritten: ref, warning: unresolvedWarning(trimmed) };
  }

  const actionName = `${segments[0]}/${segments[1]}`;
  const subpath = segments.slice(2).join("/");
  const target = known[actionName];
  if (!target) {
    return { rewritten: ref, warning: unresolvedWarning(trimmed) };
  }

  const base = target.kind === "mirror" ? `${root}/${target.repo}` : target.url;
  const withSubpath = subpath ? `${base}/${subpath}` : base;
  const pinned = target.kind === "mirror" && target.newest ? olderPin(version, target.newest) : version;
  const rewritten = pinned ? `${withSubpath}@${pinned}` : withSubpath;
  return { rewritten };
}

/**
 * `version` held to `newest`: a tag of a later major becomes `newest`, and a
 * pinned commit of a later major becomes the commit of `newest` in chant's pin
 * table (the mirror carries the same commits as GitHub's). Anything else,
 * including a commit the table does not know, passes through.
 */
function olderPin(version: string, newest: string): string {
  if (/^[0-9a-f]{40}$/.test(version)) {
    const major = pinMajor(version);
    const target = Number(newest.replace(/^v/, ""));
    return major !== undefined && major > target ? (pinAtMajor(version, newest)?.sha ?? version) : version;
  }
  return laterMajor(version, newest) ? newest : version;
}

/** Whether `version` (`v4`, `v4.1.0`) names a later major than `newest` (`v3`). A SHA or branch never does. */
function laterMajor(version: string, newest: string): boolean {
  const major = (v: string): number | undefined => {
    const m = /^v?(\d+)(?:\.\d+)*$/.exec(v);
    return m ? Number(m[1]) : undefined;
  };
  const a = major(version);
  const b = major(newest);
  return a !== undefined && b !== undefined && a > b;
}

function unresolvedWarning(ref: string): string {
  return (
    `forgejo: unresolved action ref '${ref}' — it has no built-in mapping and won't ` +
    `resolve from a GitHub Marketplace on Forgejo. Use a full repository URL, or mirror ` +
    `it under forgejo.actionsRoot in chant.config.ts.`
  );
}
