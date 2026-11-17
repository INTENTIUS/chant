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

/** The group, type, scope and description of one commit message. A subject that is not conventional is `other`, kept whole, with no type. */
export function classifyCommit(message: string): { kind: ChangelogKind; type?: string; scope?: string; subject: string } {
  const subject = message.split("\n", 1)[0]!.trim();
  const m = HEADER.exec(subject);
  const breaking = BREAKING_FOOTER.test(message) || (m !== null && m[3] === "!");
  if (!m) return { kind: breaking ? "breaking" : "other", subject };
  const type = m[1]!;
  const scope = m[2] ? m[2].trim() : undefined;
  const kind: ChangelogKind = breaking ? "breaking" : type === "feat" ? "feat" : type === "fix" ? "fix" : "other";
  return { kind, type, ...(scope ? { scope } : {}), subject: m[4]!.trim() || subject };
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

/** The commit types a forge release's notes generated from commits list when none are declared (#5153). */
export const DEFAULT_NOTES_TYPES: readonly string[] = ["feat", "fix", "perf"];

const NOTES_GROUPS: Array<[ChangelogKind, string]> = [
  ["breaking", "Breaking changes"],
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["other", "Other changes"],
];

/** Which commits a forge release's notes generated from commits list (#5153, #5270). */
export interface NotesFilter {
  /** The conventional types listed. Default `feat`, `fix` and `perf`; `*` lists every type. */
  types?: readonly string[];
  /** The conventional types left out, every other commit listed: goreleaser's `changelog.filters.exclude`. Not with `types`. */
  exclude?: readonly string[];
  /** List the commits whose subject is not conventional. Default: with `exclude` or `*` yes, with a list of types no. */
  nonConventional?: boolean;
}

/** Whether the notes list `message` under `filter` (#5270). A breaking change is listed whatever its type. */
export function notesListCommit(message: string, filter: NotesFilter = {}): boolean {
  const { kind, type } = classifyCommit(message);
  if (kind === "breaking") return true;
  const types = filter.types ?? (filter.exclude ? ["*"] : DEFAULT_NOTES_TYPES);
  const all = types.includes("*");
  if (type === undefined) return filter.nonConventional ?? all;
  if (filter.exclude?.includes(type)) return false;
  return all || types.includes(type);
}

/**
 * Release notes from `commits` (#5153), newest first as `git log` lists
 * them: the commits {@link notesListCommit} lists, grouped by
 * {@link releaseChangelog} under a `###` heading each, one line per commit
 * with its scope and short sha. `types` (default `feat`, `fix` and `perf`)
 * lists those types, `*` every commit; `exclude` lists every commit but those
 * types (#5270). Commits that are not conventional are listed with `*` or
 * `exclude` and not with a list of types, unless `nonConventional` says
 * otherwise. Empty when no commit is listed.
 */
export function changelogNotes(commits: readonly ChangelogCommit[], filter: NotesFilter | readonly string[] = {}): string {
  const f: NotesFilter = Array.isArray(filter) ? { types: filter as readonly string[] } : (filter as NotesFilter);
  const listed = commits.filter((c) => notesListCommit(c.message, f));
  const { groups } = releaseChangelog(listed);
  const out: string[] = [];
  for (const [kind, title] of NOTES_GROUPS) {
    if (groups[kind].length === 0) continue;
    if (out.length > 0) out.push("");
    out.push(`### ${title}`, "", ...groups[kind].map((e) => `- ${e.scope ? `${e.scope}: ` : ""}${e.subject} (${e.sha.slice(0, 7)})`));
  }
  return out.join("\n");
}
