/**
 * `chant workspace adopt-lineage`: give a scope that has no lineage one
 * (#2551, D5, D9, requirement P7).
 *
 * A project made before the lock existed, or copied from a template or a fork
 * of one by hand, has no record of where its files came from, so it cannot be
 * upgraded. Adoption recovers that record from the template's own tags:
 *
 * 1. Compute the template's hash index from its tags (./lineage-hash-index.ts),
 *    or reuse a cached copy for the tags whose commit it still names.
 * 2. Score each tagged version against the scope: how many of the template's
 *    files the scope holds byte for byte. The best version wins; ties go to
 *    the version whose files the scope accounts for best, then to the newest.
 * 3. Re-check the winner against the template: its files are read from the
 *    tag and hashed again, so a stale or forged cache never reaches the lock.
 * 4. Propose a lineage pinned to that tag. Each file the template has at the
 *    tag is recorded with the template's hash as its merge base, so a file the
 *    scope edited shows as edited and merges on upgrade like any other.
 * 5. Record it as adopted: the lineage carries an `adoption` naming the exact
 *    commit range it vouches for, and reads as provenance `adopted` (D5).
 *
 * D5 also has an admin at the base revision sign the adoption. Signing needs
 * the attestors of #2547, so for now the adoption's `attestation` is null.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { computeHashIndex, indexExcludes, TemplateTags, type HashIndex, type HashIndexEntry } from "./lineage-hash-index";
import { parseTemplateSource, portableUrl, readTemplateTree } from "./lineage-init";
import {
  LOCK_FILE,
  LockError,
  contentDigest,
  defaultFileClass,
  emptyLock,
  fileHash,
  readLock,
  scopeKey,
  writeLock,
  type Adoption,
  type Lineage,
} from "./lineage-lock";

export interface AdoptOptions {
  /** The directory that holds (or will hold) `.chant/workspace.lock.json`. */
  root: string;
  /** The scope to adopt, relative to `root`. Defaults to `"."`. */
  scope?: string;
  /** `<repo>[@<tag>][#<member>]`: the template. With a tag, adopt at exactly that version. */
  from: string;
  /** Only tags matching this glob are candidates, such as `chant-v*`. */
  tags?: string;
  /** A cached hash index, such as a copy the template's CI published. */
  cache?: HashIndex;
}

export interface VersionScore {
  tag: string;
  commit: string;
  /** Files the template has at the tag. */
  files: number;
  identical: number;
  edited: number;
  missing: number;
}

export interface AdoptionProposal {
  scope: string;
  template: string;
  /** The chosen version. */
  chosen: VersionScore;
  /** The next best versions that do not tie with the chosen one, best first, at most three. */
  alternatives: VersionScore[];
  /** Other versions that score exactly as the chosen one does, oldest first. `@<tag>` in `--from` picks one of them. */
  ties: string[];
  /** How many tagged versions were compared. */
  compared: number;
  /** The files, by how the scope holds them. */
  identical: string[];
  edited: string[];
  missing: string[];
  /** Where the index came from: all computed, or partly from a cache that chant re-checked for the chosen tag. */
  index: Adoption["index"];
  /** The lineage the lock would record. */
  lineage: Lineage;
  /** Whether the lock was written (false for a dry run). */
  written: boolean;
  /** Whether a `.gitignore` covers the lock, so it would not be committed without `git add -f`. */
  lockIgnored: boolean;
}

function gitRaw(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}
function gitOut(cwd: string, args: string[]): string {
  return gitRaw(cwd, args).trim();
}

function isIgnored(root: string, path: string): boolean {
  try {
    gitRaw(root, ["check-ignore", "-q", "--no-index", "--", path]);
    return true;
  } catch {
    return false;
  }
}

function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** Score one tagged version against the scope's files. */
function score(entry: HashIndexEntry, local: (path: string) => string | undefined): VersionScore {
  let identical = 0;
  let edited = 0;
  let missing = 0;
  for (const [path, sha] of Object.entries(entry.files)) {
    const have = local(path);
    if (have === undefined) missing++;
    else if (have === sha) identical++;
    else edited++;
  }
  return { tag: entry.tag, commit: entry.commit, files: Object.keys(entry.files).length, identical, edited, missing };
}

/**
 * Best first: most identical files, then fewest template files the scope does
 * not hold as they are, then the oldest version. Versions that tie hold the
 * same files, so the scope fits any of them. Adopting the oldest means an
 * upgrade replays every migration since; one that no longer applies refuses
 * the upgrade, where adopting the newest would skip it without a word.
 */
function rank(a: VersionScore & { order: number }, b: VersionScore & { order: number }): number {
  return b.identical - a.identical || a.edited + a.missing - (b.edited + b.missing) || a.order - b.order;
}

/**
 * The exact commit range an adoption covers: the scope's history up to HEAD.
 * Refuses a scope with uncommitted changes, since those are in no commit the
 * range could name.
 */
function commitRange(root: string, scope: string): Adoption["commits"] {
  let repo: string;
  let head: string;
  try {
    repo = gitOut(root, ["rev-parse", "--show-toplevel"]);
    head = gitOut(root, ["rev-parse", "HEAD"]);
  } catch {
    throw new LockError("adopt-lineage records the exact commit range it adopts, so the scope must be in a git repository with at least one commit");
  }
  const scopeDir = resolve(root, scope);
  const rel = relative(repo, scopeDir).split(sep).join("/") || ".";
  // Untrimmed: each porcelain line starts with its two status columns, which may be spaces.
  const dirty = gitRaw(repo, ["status", "--porcelain", "--untracked-files=all", "--", rel]).split("\n").filter(Boolean);
  if (dirty.length > 0) {
    throw new LockError(
      `the scope has uncommitted changes (${dirty.slice(0, 5).map((l) => l.slice(3)).join(", ")}${dirty.length > 5 ? ", …" : ""}). Commit them first: an adoption covers an exact commit range, and they are in none.`,
    );
  }
  const commits = gitOut(repo, ["rev-list", head, "--", rel]).split("\n").filter(Boolean);
  if (commits.length === 0) throw new LockError(`no commit touches ${rel}; commit the scope first`);
  return { first: commits[commits.length - 1], last: head, count: commits.length };
}

/**
 * Propose a lineage for a scope with none, and record it unless `dryRun`.
 * Throws a {@link LockError} when the scope already has a lineage, when no
 * tagged version shares a file with it, or when the template cannot be read.
 */
export function adoptLineage(options: AdoptOptions & { dryRun?: boolean }): AdoptionProposal {
  const root = resolve(options.root);
  const scope = scopeKey(options.scope ?? ".");
  const scopeDir = join(root, scope);
  if (!existsSync(scopeDir) || !statSync(scopeDir).isDirectory()) throw new LockError(`scope "${scope}" is not a directory under ${root}`);
  const lock = readLock(root) ?? emptyLock();
  if (lock.scopes[scope]) {
    throw new LockError(`${LOCK_FILE} already has a lineage for scope "${scope}" (${lock.scopes[scope].template}); adopt-lineage is for a scope with none`);
  }
  const spec = parseTemplateSource(options.from, root, "--from");
  const commits = commitRange(root, scope);

  const hashes = new Map<string, string | undefined>();
  const local = (path: string): string | undefined => {
    if (!hashes.has(path)) {
      const abs = join(scopeDir, path);
      hashes.set(path, existsSync(abs) && statSync(abs).isFile() ? fileHash(readFileSync(abs)) : undefined);
    }
    return hashes.get(path);
  };

  const label = spec.member ? `${spec.repo}#${spec.member}` : spec.repo;
  const tags = new TemplateTags(spec.url, spec.member, label);
  try {
    let { index, cached } = computeHashIndex(tags, spec.id, { pattern: options.tags, cache: options.cache, only: spec.ref });
    let usedCache = cached.size > 0;
    for (;;) {
      const ranked = index.tags
        .map((entry, order) => ({ ...score(entry, local), order }))
        .sort(rank);
      const best = ranked[0];
      if (!best || best.identical === 0) {
        throw new LockError(
          `no tagged version of ${label} shares a file with scope "${scope}" (compared ${index.tags.length} version(s)); check --from${spec.member ? "" : " and its #<member>"}, or --tags`,
        );
      }
      const entry = index.tags[best.order];
      const tie = (r: VersionScore): boolean => r.identical === best.identical && r.edited + r.missing === best.edited + best.missing;

      // Re-check the winner against the template itself: the lock records only hashes chant computed.
      tags.fetchTags([entry.tag]);
      const fresh = tags.entry({ tag: entry.tag, commit: entry.commit });
      if (fresh === null || fresh.tree !== entry.tree || !sameFiles(fresh.files, entry.files)) {
        if (!cached.has(entry.tag)) throw new LockError(`${label}@${entry.tag} changed while it was read; try again`);
        // A stale or wrong cache: drop it and compute every tag from the template.
        ({ index, cached } = computeHashIndex(tags, spec.id, { pattern: options.tags, only: spec.ref }));
        usedCache = false;
        continue;
      }
      const read = readTemplateTree(tags.scratch, entry.commit, spec.member, `${label}@${entry.tag}`);
      const files = new Map<string, Buffer>();
      for (const [path, f] of read.files) if (!indexExcludes(path)) files.set(path, f.data);

      const identical: string[] = [];
      const edited: string[] = [];
      const missing: string[] = [];
      const recorded: Lineage["files"] = {};
      for (const [path, sha] of Object.entries(fresh.files)) {
        const have = local(path);
        (have === undefined ? missing : have === sha ? identical : edited).push(path);
        recorded[path] = { ...defaultFileClass(path), sha256: sha };
      }
      const chosen: VersionScore = { tag: best.tag, commit: best.commit, files: best.files, identical: best.identical, edited: best.edited, missing: best.missing };
      const lineage: Lineage = {
        kind: "template",
        template: spec.id,
        source: { type: "git", repo: spec.repo, url: portableUrl(spec.url, root), ...(spec.member ? { path: spec.member } : {}) },
        ref: entry.tag,
        address: { digest: contentDigest(files), commit: entry.commit, tree: entry.tree },
        parameters: {},
        migrations: [],
        files: recorded,
        manualSteps: [],
        adoption: {
          provenance: "adopted",
          commits,
          match: { files: chosen.files, identical: chosen.identical, edited: chosen.edited, missing: chosen.missing },
          index: usedCache ? "cache" : "computed",
          attestation: null,
        },
      };
      if (!options.dryRun) {
        lock.scopes[scope] = lineage;
        writeLock(root, lock);
      }
      return {
        scope,
        template: spec.id,
        chosen,
        alternatives: ranked.slice(1).filter((r) => !tie(r)).slice(0, 3).map(({ order: _o, ...s }) => s),
        ties: ranked.slice(1).filter(tie).map((r) => r.tag),
        compared: index.tags.length,
        identical,
        edited,
        missing,
        index: lineage.adoption!.index,
        lineage,
        written: !options.dryRun,
        lockIgnored: isIgnored(root, LOCK_FILE),
      };
    }
  } finally {
    tags.dispose();
  }
}

/** One line per fact, for the terminal. */
export function describeProposal(p: AdoptionProposal): string[] {
  const at = (path: string) => (p.scope === "." ? path : `${p.scope}/${path}`);
  const c = p.chosen;
  const lines = [
    `${p.scope}  ${p.template}@${c.tag} (${c.commit.slice(0, 12)})  adopted`,
    `  matched ${c.identical} of ${c.files} template file(s); ${c.edited} edited, ${c.missing} not in the scope; ${p.compared} version(s) compared`,
  ];
  if (p.ties.length > 0) {
    lines.push(
      `  ${p.ties.length} later version(s) match equally (${p.ties[0]}${p.ties.length > 1 ? ` to ${p.ties[p.ties.length - 1]}` : ""}); adopting the oldest. Name one with --from <repo>@<tag> if the scope came from it.`,
    );
  }
  for (const a of p.alternatives) lines.push(`  next: ${a.tag}, ${a.identical} of ${a.files} identical, ${a.edited} edited, ${a.missing} missing`);
  for (const path of p.edited) lines.push(`  edited: ${at(path)}`);
  for (const path of p.missing) lines.push(`  not in the scope: ${at(path)}`);
  const a = p.lineage.adoption!;
  lines.push(`  commits: ${a.commits.first.slice(0, 12)}..${a.commits.last.slice(0, 12)} (${a.commits.count}), unsigned until attestors exist (#2547)`);
  lines.push(`  index: ${p.index === "cache" ? "from the cache, re-checked at the chosen tag" : "computed from the template's tags"}`);
  return lines;
}
