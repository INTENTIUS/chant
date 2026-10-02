/**
 * `chant workspace adopt-lineage`: give a scope a git lineage it can be
 * upgraded from (#2551, D5, D9, requirement P7).
 *
 * Two cases, told apart by what the lock already holds for the scope.
 *
 * A scope with no lineage, such as a project made before the lock existed or
 * copied by hand from a template or a fork of one, has no record of where its
 * files came from. Adoption recovers it from the template's own versions:
 *
 * 1. Compute the template's hash index from its tags (./lineage-hash-index.ts),
 *    or reuse a cached copy for the tags whose commit it still names.
 * 2. Score each version against the scope: how many of the template's files
 *    the scope holds byte for byte. The best version wins; ties go to the
 *    version whose files the scope accounts for best, then to the oldest.
 * 3. Re-check a winner that came from the cache against the template itself,
 *    so a stale or forged cache never reaches the lock.
 * 4. Record a lineage pinned to that version. Each file the template has
 *    there is recorded with the template's hash, after the template's
 *    parameters are substituted (#2627), as its merge base, so a file the
 *    scope edited shows as edited and merges on upgrade like any other.
 * 5. Record the adoption under P7: the exact commit range it vouches for,
 *    everything up to HEAD, goes into the lineage and into
 *    `.chant/trust.json`'s `adopted` list. That file is policy, read at the
 *    base revision, and editing it is a protected write, so the range counts
 *    only once an admin has merged it. The scope then reads as `adopted`
 *    (./lineage-provenance.ts).
 *
 * A scope with a directory lineage (#2647) already has a lineage, but no
 * history to rebuild a merge base from once the directory changes. The
 * studio's boxes are made this way, with `chant init --from ~/box/template`,
 * and a kit release replaces that directory. Adoption moves such a scope onto
 * the git repository the directory was copied from: every candidate version
 * is rendered with the parameters the lock recorded, and only a version that
 * reproduces every hash the lock recorded qualifies. The merge base is then
 * the same files, so the lineage keeps its files, parameters and migrations,
 * and only its source, ref and address change. Nothing about the scope's
 * history is claimed, so no commit range is admitted.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { computeHashIndex, indexExcludes, TemplateTags, type HashIndex, type HashIndexEntry } from "./lineage-hash-index";
import { parseTemplateSource, portableUrl, readTemplateTree } from "./lineage-init";
import {
  LOCK_FILE,
  LockError,
  contentDigest,
  declaredFilesAt,
  emptyLock,
  fileEntries,
  fileHash,
  readLock,
  scopeKey,
  writeLock,
  type Adoption,
  type Lineage,
} from "./lineage-lock";
import { splitMigrations } from "./lineage-migrations";
import { carryParameters, readManifest, resolveParameters, substituteParameters } from "./template-manifest";
import { repinSubstituted, type RepinnedRecord } from "./template-pins";

/** Where the trust policy lives, relative to the repository root (./trust/policy.ts). */
const TRUST_FILE = ".chant/trust.json";

export interface AdoptOptions {
  /** The directory that holds (or will hold) `.chant/workspace.lock.json`. */
  root: string;
  /** The scope to adopt, relative to `root`. Defaults to `"."`. */
  scope?: string;
  /** `<repo>[@<ref>][#<member>]`: the template. With a ref, adopt at exactly that version. */
  from: string;
  /** Only tags matching this glob are candidates, such as `kit-v*`. */
  tags?: string;
  /** A cached hash index, such as a copy the template's CI published. */
  cache?: HashIndex;
  /** `--param name=value` values for a template with a `chant.template.json`; only for a scope with no lineage. */
  params?: Record<string, string>;
  dryRun?: boolean;
}

export interface VersionScore {
  tag: string;
  commit: string;
  /** Files the template has at the version. */
  files: number;
  identical: number;
  edited: number;
  missing: number;
}

export interface AdoptionResult {
  scope: string;
  /** `files` for a scope with no lineage, `lineage` for a directory lineage moved onto git. */
  by: Adoption["by"];
  template: string;
  chosen: VersionScore;
  /** The next best versions that do not tie with the chosen one, best first, at most three. */
  alternatives: VersionScore[];
  /** Other versions that score exactly as the chosen one does. `@<ref>` in `--from` picks one of them. */
  ties: string[];
  /** How many versions were compared. */
  compared: number;
  /** The files, by how the scope holds them (for `lineage`, by how the lock recorded them). */
  identical: string[];
  edited: string[];
  missing: string[];
  index: Adoption["index"];
  /** The lineage the lock records. */
  lineage: Lineage;
  /** The `.chant/trust.json` entry the adoption adds, for `files`. Null when it is already there or for `lineage`. */
  trust: { path: string; entry: { to: string; note: string } } | null;
  /** Whether the lock (and the trust entry) were written: false for a dry run. */
  written: boolean;
  /** Whether a `.gitignore` covers the lock, so it would not be committed without `git add -f`. */
  lockIgnored: boolean;
}

function gitRaw(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

function isIgnored(root: string, path: string): boolean {
  try {
    gitRaw(root, ["check-ignore", "-q", "--no-index", "--", path]);
    return true;
  } catch {
    return false;
  }
}

/** Score one version against a lookup of the scope's hashes. */
function score(entry: { tag: string; commit: string; files: Record<string, string> }, have: (path: string) => string | undefined): VersionScore {
  let identical = 0;
  let edited = 0;
  let missing = 0;
  for (const [path, sha] of Object.entries(entry.files)) {
    const h = have(path);
    if (h === undefined) missing++;
    else if (h === sha) identical++;
    else edited++;
  }
  return { tag: entry.tag, commit: entry.commit, files: Object.keys(entry.files).length, identical, edited, missing };
}

type Ranked = VersionScore & { order: number };

/**
 * Best first: most identical files, then fewest template files the scope does
 * not hold as they are, then the oldest version. Versions that tie hold the
 * same files, so the scope fits any of them. Adopting the oldest means an
 * upgrade replays every migration since; one that no longer applies refuses
 * the upgrade, where adopting the newest would skip it without a word.
 */
function rank(a: Ranked, b: Ranked): number {
  return b.identical - a.identical || a.edited + a.missing - (b.edited + b.missing) || a.order - b.order;
}

const ties = (best: VersionScore) => (r: VersionScore) => r.identical === best.identical && r.edited + r.missing === best.edited + best.missing;
const plain = ({ order: _o, ...s }: Ranked): VersionScore => s;

/**
 * HEAD of the repository holding the scope, once the scope and the lock have
 * no uncommitted changes: an adoption names an exact commit, and uncommitted
 * files are in none.
 */
function adoptedAt(root: string, scope: string): { repo: string; head: string } {
  let repo: string;
  let head: string;
  try {
    repo = gitRaw(root, ["rev-parse", "--show-toplevel"]).trim();
    head = gitRaw(root, ["rev-parse", "HEAD"]).trim();
  } catch {
    throw new LockError("adopt-lineage records the exact commit it adopts at, so the scope must be in a git repository with at least one commit");
  }
  // Untrimmed: each porcelain line starts with its two status columns, which may be spaces.
  const dirty = gitRaw(root, ["status", "--porcelain", "--untracked-files=all", "--", scope === "." ? "." : scope, LOCK_FILE])
    .split("\n")
    .filter(Boolean);
  if (dirty.length > 0) {
    throw new LockError(
      `the scope has uncommitted changes (${dirty.slice(0, 5).map((l) => l.slice(3)).join(", ")}${dirty.length > 5 ? ", …" : ""}). Commit them first: an adoption names an exact commit, and they are in none.`,
    );
  }
  return { repo, head };
}

/** A version's files as a project made from it holds them: parameters substituted, manifest and migrations left out. */
function instantiate(
  raw: Map<string, Buffer>,
  values: (manifest: ReturnType<typeof readManifest>) => Record<string, string>,
): { files: Map<string, Buffer>; parameters: Record<string, string>; repinned: RepinnedRecord[] } {
  const manifest = readManifest(raw);
  const parameters = values(manifest);
  const { files, repinned } = repinSubstituted(raw, substituteParameters(raw, manifest, parameters), manifest?.files ?? []);
  const kept = new Map<string, Buffer>();
  for (const [path, data] of splitMigrations(files).files) if (!indexExcludes(path)) kept.set(path, data);
  return { files: kept, parameters, repinned };
}

function readRaw(tags: TemplateTags, entry: HashIndexEntry, member: string | undefined, label: string): Map<string, Buffer> {
  const read = readTemplateTree(tags.scratch, entry.commit, member, `${label}@${entry.tag}`);
  return new Map([...read.files].map(([path, f]) => [path, f.data]));
}

/** Add the adoption's range to `.chant/trust.json`, keeping everything else in it. Returns null when an entry already covers it. */
function trustEntry(repo: string, head: string, note: string): { path: string; entry: { to: string; note: string }; text: string } | null {
  const abs = join(repo, TRUST_FILE);
  let config: Record<string, unknown> = { schema: 1 };
  if (existsSync(abs)) {
    try {
      config = JSON.parse(readFileSync(abs, "utf-8")) as Record<string, unknown>;
    } catch (err) {
      throw new LockError(`${TRUST_FILE} is not valid JSON, so the adoption cannot be added to it: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const adopted = Array.isArray(config.adopted) ? (config.adopted as Array<{ to?: unknown }>) : [];
  if (adopted.some((r) => r.to === head)) return null;
  const entry = { to: head, note };
  config.adopted = [...adopted, entry];
  return { path: TRUST_FILE, entry, text: JSON.stringify(config, null, 2) + "\n" };
}

/**
 * Adopt a lineage for the scope, and record it unless `dryRun`. Throws a
 * {@link LockError} when the scope has a lineage that is not a directory
 * lineage, when no version fits, or when the template cannot be read.
 */
export function adoptLineage(options: AdoptOptions): AdoptionResult {
  const root = resolve(options.root);
  const scope = scopeKey(options.scope ?? ".");
  const scopeDir = join(root, scope);
  if (!existsSync(scopeDir) || !statSync(scopeDir).isDirectory()) throw new LockError(`scope "${scope}" is not a directory under ${root}`);
  const lock = readLock(root) ?? emptyLock();
  const existing = lock.scopes[scope];
  if (existing && existing.source.type !== "dir") {
    throw new LockError(
      `${LOCK_FILE} already has a lineage for scope "${scope}" (${existing.template}, ${existing.source.type}). adopt-lineage gives a lineage to a scope with none, or moves a directory lineage onto git`,
    );
  }
  if (existing && existing.manualSteps.length > 0) {
    throw new LockError(`scope "${scope}" has ${existing.manualSteps.length} open manual step(s); resolve them before moving its lineage`);
  }
  if (existing && options.params && Object.keys(options.params).length > 0) {
    throw new LockError(`scope "${scope}" already records its parameters; --param is only for a scope with no lineage`);
  }
  const spec = parseTemplateSource(options.from, root, "--from");
  const { repo, head } = adoptedAt(root, scope);
  const label = spec.member ? `${spec.repo}#${spec.member}` : spec.repo;
  const tags = new TemplateTags(spec.url, spec.member, label);
  try {
    const result = existing
      ? fromDirectoryLineage(tags, existing, { spec, label, pattern: options.tags, head })
      : fromFiles(tags, scopeDir, { spec, label, pattern: options.tags, cache: options.cache, params: options.params ?? {}, head });
    const lineage: Lineage = { ...result.lineage, source: { type: "git", repo: spec.repo, url: portableUrl(spec.url, root), ...(spec.member ? { path: spec.member } : {}) } };
    const trust = lineage.adoption!.by === "files" ? trustEntry(repo, head, `adopt-lineage ${scope} ${spec.id}@${result.chosen.tag}`) : null;
    if (!options.dryRun) {
      lock.scopes[scope] = lineage;
      writeLock(root, lock);
      if (trust) {
        mkdirSync(dirname(join(repo, trust.path)), { recursive: true });
        writeFileSync(join(repo, trust.path), trust.text);
      }
    }
    return {
      ...result,
      scope,
      template: spec.id,
      lineage,
      trust: trust ? { path: trust.path, entry: trust.entry } : null,
      written: !options.dryRun,
      lockIgnored: isIgnored(root, LOCK_FILE),
    };
  } finally {
    tags.dispose();
  }
}

type Found = Omit<AdoptionResult, "scope" | "template" | "trust" | "written" | "lockIgnored">;

/** A scope with no lineage: matched by its files. */
function fromFiles(
  tags: TemplateTags,
  scopeDir: string,
  o: { spec: ReturnType<typeof parseTemplateSource>; label: string; pattern?: string; cache?: HashIndex; params: Record<string, string>; head: string },
): Found {
  const hashes = new Map<string, string | undefined>();
  const local = (path: string): string | undefined => {
    if (!hashes.has(path)) {
      const abs = join(scopeDir, path);
      hashes.set(path, existsSync(abs) && statSync(abs).isFile() ? fileHash(readFileSync(abs)) : undefined);
    }
    return hashes.get(path);
  };

  let { index, cached } = computeHashIndex(tags, o.spec.id, { pattern: o.pattern, cache: o.cache, only: o.spec.ref });
  for (;;) {
    const ranked = index.tags.map((entry, order) => ({ ...score(entry, local), order })).sort(rank);
    const best = ranked[0];
    if (!best || best.identical === 0) {
      throw new LockError(
        `no version of ${o.label} shares a file with the scope (compared ${index.tags.length}); check --from${o.spec.member ? "" : " and its #<member>"}, or --tags`,
      );
    }
    const entry = index.tags[best.order];
    if (cached.has(entry.tag)) {
      // Re-check a cached winner against the template itself: the lock records only hashes chant computed.
      tags.fetchTags([entry.tag]);
      const fresh = tags.entry({ tag: entry.tag, commit: entry.commit });
      if (fresh === null || fresh.tree !== entry.tree || JSON.stringify(fresh.files) !== JSON.stringify(entry.files)) {
        // A stale or wrong cache: drop it and compute every version from the template.
        ({ index, cached } = computeHashIndex(tags, o.spec.id, { pattern: o.pattern, only: o.spec.ref }));
        continue;
      }
    }
    const usedCache = cached.size > 0;

    // The version as a project made from it holds it: the scope's own parameter values substituted (#2627).
    const made = instantiate(readRaw(tags, entry, o.spec.member, o.label), (manifest) => resolveParameters(manifest, o.params));
    const files = fileEntries(made.files, declaredFilesAt(scopeDir));
    const identical: string[] = [];
    const edited: string[] = [];
    const missing: string[] = [];
    for (const [path, e] of Object.entries(files)) {
      const have = local(path);
      (have === undefined ? missing : have === e.sha256 ? identical : edited).push(path);
    }
    const match = { files: Object.keys(files).length, identical: identical.length, edited: edited.length, missing: missing.length };
    const lineage: Lineage = {
      kind: "template",
      template: o.spec.id,
      source: { type: "git", repo: o.spec.repo, url: o.spec.url },
      ref: entry.tag,
      address: { digest: contentDigest(made.files), commit: entry.commit, tree: entry.tree },
      parameters: made.parameters,
      ...(made.repinned.length > 0 ? { repinned: made.repinned } : {}),
      migrations: [],
      files,
      manualSteps: [],
      adoption: { by: "files", commits: { to: o.head }, match, index: usedCache ? "cache" : "computed" },
    };
    return {
      by: "files",
      chosen: { tag: entry.tag, commit: entry.commit, ...match },
      alternatives: ranked.slice(1).filter((r) => !ties(best)(r)).slice(0, 3).map(plain),
      ties: ranked.slice(1).filter(ties(best)).map((r) => r.tag),
      compared: index.tags.length,
      identical,
      edited,
      missing,
      index: lineage.adoption!.index,
      lineage,
    };
  }
}

/**
 * A directory lineage moved onto git: the version must reproduce, with the
 * recorded parameters, the hash of every file the lock records (generated
 * files aside, since they are rebuilt and never merged).
 */
function fromDirectoryLineage(
  tags: TemplateTags,
  existing: Lineage,
  o: { spec: ReturnType<typeof parseTemplateSource>; label: string; pattern?: string; head: string },
): Found {
  const { index } = computeHashIndex(tags, o.spec.id, { pattern: o.pattern, only: o.spec.ref });
  const recorded = Object.entries(existing.files).filter(([, e]) => e.class !== "generated");
  const candidates: Array<Ranked & { entry: HashIndexEntry; made: ReturnType<typeof instantiate>; exact: boolean; differ: string[] }> = [];
  index.tags.forEach((entry, order) => {
    let made: ReturnType<typeof instantiate>;
    try {
      made = instantiate(readRaw(tags, entry, o.spec.member, o.label), (manifest) => carryParameters(manifest, existing.parameters));
    } catch {
      // A version whose manifest the recorded parameters do not satisfy cannot be the one the scope was made from.
      return;
    }
    const at = new Map([...made.files].map(([p, d]) => [p, fileHash(d)]));
    const s = score({ tag: entry.tag, commit: entry.commit, files: Object.fromEntries(recorded.map(([p, e]) => [p, e.sha256])) }, (p) => at.get(p));
    const differ = recorded.filter(([p, e]) => at.get(p) !== e.sha256).map(([p]) => p);
    candidates.push({ ...s, files: made.files.size, order, entry, made, exact: contentDigest(made.files) === existing.address?.digest, differ });
  });
  const fits = candidates.filter((c) => c.differ.length === 0).sort((a, b) => Number(b.exact) - Number(a.exact) || a.order - b.order);
  if (fits.length === 0) {
    const near = [...candidates].sort((a, b) => a.differ.length - b.differ.length || a.order - b.order)[0];
    throw new LockError(
      `no version of ${o.label} reproduces the files the scope was made from (compared ${index.tags.length}${o.pattern ? `, tags ${o.pattern}` : ""})` +
        (near ? `; the nearest, ${near.tag}, differs in ${near.differ.slice(0, 5).join(", ")}${near.differ.length > 5 ? ", …" : ""}` : "") +
        `. Name the commit the directory was copied from with --from <repo>@<ref>, or upgrade from a directory that still holds those files.`,
    );
  }
  const chosen = fits[0];
  const files = Object.keys(existing.files);
  const match = { files: chosen.files, identical: recorded.length, edited: 0, missing: 0 };
  const lineage: Lineage = {
    ...existing,
    template: o.spec.id,
    source: { type: "git", repo: o.spec.repo, url: o.spec.url },
    ref: chosen.entry.tag,
    address: { digest: contentDigest(chosen.made.files), commit: chosen.entry.commit, tree: chosen.entry.tree },
    adoption: {
      by: "lineage",
      commits: { to: o.head },
      match,
      index: "computed",
      previous: { template: existing.template, source: existing.source },
    },
  };
  const same = (c: (typeof fits)[number]) => c.exact === chosen.exact;
  return {
    by: "lineage",
    chosen: { tag: chosen.tag, commit: chosen.commit, ...match },
    alternatives: [],
    ties: fits.slice(1).filter(same).map((c) => c.tag),
    compared: index.tags.length,
    identical: files.filter((p) => existing.files[p].class !== "generated"),
    edited: [],
    missing: [],
    index: "computed",
    lineage,
  };
}

/** One line per fact, for the terminal. */
export function describeAdoption(p: AdoptionResult): string[] {
  const at = (path: string) => (p.scope === "." ? path : `${p.scope}/${path}`);
  const c = p.chosen;
  const lines = [`${p.scope}  ${p.template}@${c.tag} (${c.commit.slice(0, 12)})`];
  if (p.by === "lineage") {
    const prev = p.lineage.adoption!.previous!;
    lines.push(`  moved from ${prev.template}: every one of the ${c.identical} recorded file(s) has the same content at ${c.tag}; ${p.compared} version(s) compared`);
  } else {
    lines.push(`  matched ${c.identical} of ${c.files} template file(s); ${c.edited} edited, ${c.missing} not in the scope; ${p.compared} version(s) compared`);
  }
  if (p.ties.length > 0) {
    const named = p.ties.length > 3 ? `${p.ties[0]} to ${p.ties[p.ties.length - 1]}` : p.ties.join(", ");
    lines.push(`  ${p.ties.length} later version(s) fit equally (${named}); the oldest is chosen. Name one with --from <repo>@<ref> if the scope came from it.`);
  }
  for (const a of p.alternatives) lines.push(`  next: ${a.tag}, ${a.identical} of ${a.files} identical, ${a.edited} edited, ${a.missing} missing`);
  for (const path of p.edited) lines.push(`  edited: ${at(path)}`);
  for (const path of p.missing) lines.push(`  not in the scope: ${at(path)}`);
  if (p.by === "files") {
    lines.push(`  index: ${p.index === "cache" ? "from the cache, re-checked at the chosen version" : "computed from the template"}`);
    lines.push(
      p.trust
        ? `  adopted range: up to ${p.trust.entry.to.slice(0, 12)}, added to ${p.trust.path}; it counts once that change is merged to the base branch`
        : `  adopted range: up to ${p.lineage.adoption!.commits.to.slice(0, 12)}, already in ${TRUST_FILE}`,
    );
  }
  return lines;
}
