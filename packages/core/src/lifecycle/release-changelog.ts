/**
 * A release's changelog from its conventional commits (#4597, terragucci#1289
 * bundle B). {@link releaseChangelog} groups the commits a version shipped
 * into breaking changes, features, fixes and the rest, each with its sha and
 * subject, and names the bump they imply, in the shape the release catalog
 * takes (`CatalogChangelogInput`, ./release-catalog.ts).
 *
 * The bump follows terragucci's `bumpFor` (`publish/semver.ts`): a `type!:`
 * subject or a `BREAKING CHANGE` (or `BREAKING-CHANGE`) footer is a major,
 * `feat` a minor, and anything else a patch, since a changed component is
 * always published at a new version. terragucci can call this behind its
 * feature-detect once chant ships it.
 *
 * Pure: the caller reads the commits (`git log`) and passes them in.
 */
import type { CatalogChangelogEntry, ChangelogKind, ReleaseBump } from "./release-catalog";

/** One commit: its sha and its full message, subject first. */
export interface ChangelogCommit {
  sha: string;
  message: string;
}

/** The changelog of one release. */
export interface ReleaseChangelog {
  /** The bump the commits imply. */
  bump: ReleaseBump;
  /** Every commit, in the order given, with its group. */
  entries: CatalogChangelogEntry[];
  /** The entries of each group, in the order given. */
  groups: Record<ChangelogKind, CatalogChangelogEntry[]>;
}

const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.*)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

/** The group, scope and description of one commit message. A subject that is not conventional is `other`, kept whole. */
export function classifyCommit(message: string): { kind: ChangelogKind; scope?: string; subject: string } {
  const subject = message.split("\n", 1)[0]!.trim();
  const m = HEADER.exec(subject);
  const breaking = BREAKING_FOOTER.test(message) || (m !== null && m[3] === "!");
  if (!m) return { kind: breaking ? "breaking" : "other", subject };
  const type = m[1]!;
  const scope = m[2] ? m[2].trim() : undefined;
  const kind: ChangelogKind = breaking ? "breaking" : type === "feat" ? "feat" : type === "fix" ? "fix" : "other";
  return { kind, ...(scope ? { scope } : {}), subject: m[4]!.trim() || subject };
}

/** The bump a set of commit messages implies, as terragucci's `bumpFor` decides it. */
export function changelogBump(messages: readonly string[]): ReleaseBump {
  let bump: ReleaseBump = "patch";
  for (const message of messages) {
    const subject = message.split("\n", 1)[0]!;
    if (/^\w+(\([^)]*\))?!:/.test(subject) || BREAKING_FOOTER.test(message)) return "major";
    if (/^feat(\([^)]*\))?:/.test(subject)) bump = "minor";
  }
  return bump;
}

/** Group `commits` and name their bump. */
export function releaseChangelog(commits: readonly ChangelogCommit[]): ReleaseChangelog {
  const groups: Record<ChangelogKind, CatalogChangelogEntry[]> = { breaking: [], feat: [], fix: [], other: [] };
  const entries: CatalogChangelogEntry[] = [];
  for (const c of commits) {
    const { kind, scope, subject } = classifyCommit(c.message);
    const entry: CatalogChangelogEntry = { kind, sha: c.sha, subject, ...(scope ? { scope } : {}) };
    entries.push(entry);
    groups[kind].push(entry);
  }
  return { bump: changelogBump(commits.map((c) => c.message)), entries, groups };
}
