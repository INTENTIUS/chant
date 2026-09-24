/**
 * The hash index that `chant workspace adopt-lineage` matches a scope against
 * (#2551, D9, ws-006).
 *
 * For each tagged version of a template, the index lists every file the
 * template has at that version with the SHA-256 of its content. It is computed
 * on demand from the template's tags: no registry holds it, and a template
 * needs no extra publishing to be adoptable. A template's CI may publish a copy
 * (`chant workspace hash-index`) and an adopter may pass it with `--index`.
 * That copy is a cache only. chant reuses an entry only while the tag still
 * names the commit the entry records, and it recomputes the entry it adopts
 * from the template itself before anything reaches the lock.
 *
 * ws-006 also names parameter masking: rendering each version with and without
 * its parameters, so a file that differs only by a parameter value still
 * matches. Git templates have no declared parameters yet (every lock records
 * `parameters: {}`), so the index hashes the files as the tag holds them. When
 * templates gain parameters, a masked hash per file joins the entry.
 *
 * The network steps are `git ls-remote --tags` and one `git fetch` of the tags
 * to compute, both catalogued in `test/egress-catalogue.ts`. A local
 * repository reaches nothing.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { git } from "./lineage-init";
import { LOCK_FILE, LockError } from "./lineage-lock";
import { MIGRATIONS_DIR } from "./lineage-migrations";
import { compareVersions, parseVersion } from "./lineage-version";

/** The index format this chant reads and writes. */
export const HASH_INDEX_VERSION = 1;

const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ObjectId = z.string().regex(/^[0-9a-f]{40,64}$/);

const EntrySchema = z
  .object({
    tag: z.string().min(1),
    commit: ObjectId,
    /** The tree of the template's directory at the tag. */
    tree: ObjectId,
    /** Per file, relative to the template's directory: `sha256:<hex>` of its content. */
    files: z.record(z.string(), Sha256),
  })
  .strict();
export type HashIndexEntry = z.infer<typeof EntrySchema>;

const IndexSchema = z
  .object({
    indexVersion: z.literal(HASH_INDEX_VERSION),
    /** The template id, as the lock writes it: `github.com/acme/starter#service`. */
    template: z.string().min(1),
    /** Oldest version first. */
    tags: z.array(EntrySchema),
  })
  .strict();
export type HashIndex = z.infer<typeof IndexSchema>;

/** Read and validate an index file, such as a copy a template's CI published. */
export function readHashIndex(path: string): HashIndex {
  if (!existsSync(path)) throw new LockError(`no hash index at ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new LockError(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = IndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LockError(`invalid hash index ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export function renderHashIndex(index: HashIndex): string {
  return JSON.stringify(IndexSchema.parse(index), null, 2) + "\n";
}

/** Whether a template path is left out of the index: files a project never receives from the template. */
export function indexExcludes(path: string): boolean {
  return path === LOCK_FILE || path.startsWith(`${MIGRATIONS_DIR}/`);
}

/** A tag glob (`*` and `?`) as a regular expression over the whole tag name. */
function globRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

export interface RemoteTag {
  tag: string;
  /** The commit the tag names, peeled through an annotated tag. */
  commit: string;
}

/**
 * A scratch repository to read a template's tags in. Every method works on it;
 * `dispose()` deletes it.
 */
export class TemplateTags {
  readonly scratch: string;
  private readonly blobHashes = new Map<string, string>();
  private readonly fetched = new Set<string>();

  constructor(
    readonly url: string,
    readonly member: string | undefined,
    readonly label: string,
  ) {
    this.scratch = mkdtempSync(join(tmpdir(), "chant-hash-index-"));
    git(this.scratch, ["init", "-q"]);
  }

  dispose(): void {
    rmSync(this.scratch, { recursive: true, force: true });
  }

  /**
   * The template's version tags, oldest first: every tag whose name reads as
   * a version, narrowed by `pattern` when given (`chant-v*`).
   */
  listTags(pattern?: string): RemoteTag[] {
    let out: string;
    try {
      // A network step of adopt-lineage and hash-index, catalogued in test/egress-catalogue.ts.
      out = git(this.scratch, ["ls-remote", "--tags", this.url]);
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.toString().trim();
      throw new LockError(`could not list the tags of ${this.label}${stderr ? `: ${stderr}` : ""}`);
    }
    const byTag = new Map<string, string>();
    const peeled = new Set<string>();
    for (const line of out.split("\n")) {
      const [sha, ref] = line.split("\t");
      if (!sha || !ref?.startsWith("refs/tags/")) continue;
      const name = ref.slice("refs/tags/".length);
      if (name.endsWith("^{}")) {
        const tag = name.slice(0, -3);
        byTag.set(tag, sha);
        peeled.add(tag);
      } else if (!peeled.has(name)) {
        byTag.set(name, sha);
      }
    }
    const match = pattern ? globRegExp(pattern) : null;
    return [...byTag.entries()]
      .filter(([tag]) => parseVersion(tag) !== null && (!match || match.test(tag)))
      .map(([tag, commit]) => ({ tag, commit }))
      .sort((a, b) => compareVersions(parseVersion(a.tag)!, parseVersion(b.tag)!) || a.tag.localeCompare(b.tag));
  }

  /** Fetch the given tags, one commit deep each, in as few `git fetch` calls as the argument limit allows. */
  fetchTags(tags: string[]): void {
    const todo = tags.filter((t) => !this.fetched.has(t));
    for (let i = 0; i < todo.length; i += 100) {
      const batch = todo.slice(i, i + 100);
      try {
        // A network step of adopt-lineage and hash-index, catalogued in test/egress-catalogue.ts.
        git(this.scratch, ["fetch", "-q", "--depth", "1", "--no-tags", this.url, ...batch.map((t) => `+refs/tags/${t}:refs/tags/${t}`)]);
      } catch (err) {
        const stderr = (err as { stderr?: string }).stderr?.toString().trim();
        throw new LockError(`could not fetch the tags of ${this.label}${stderr ? `: ${stderr}` : ""}`);
      }
      for (const t of batch) this.fetched.add(t);
    }
  }

  /**
   * The index entry of one fetched tag: its tree and the SHA-256 of every file
   * under the template's directory. Null when the directory does not exist at
   * that tag: a template kept in one directory of a larger repository is
   * absent from the tags cut before it was added.
   */
  entry(tag: RemoteTag): HashIndexEntry | null {
    let tree: string;
    try {
      tree = git(this.scratch, ["rev-parse", this.member ? `${tag.commit}:${this.member}` : `${tag.commit}^{tree}`]);
      if (git(this.scratch, ["cat-file", "-t", tree]) !== "tree") throw new Error("not a tree");
    } catch {
      return null;
    }
    const listing = execFileSync("git", ["ls-tree", "-r", "-z", tree], { cwd: this.scratch, maxBuffer: 256 * 1024 * 1024 }).toString("utf-8");
    const blobs: Array<{ path: string; sha: string }> = [];
    for (const row of listing.split("\0")) {
      if (!row) continue;
      const tab = row.indexOf("\t");
      const [mode, type, sha] = row.slice(0, tab).split(" ");
      const path = row.slice(tab + 1);
      // The same files `chant init --from` copies: no symbolic links, submodules, lock or migrations.
      if (type !== "blob" || mode === "120000" || indexExcludes(path)) continue;
      blobs.push({ path, sha });
    }
    this.hashBlobs(blobs.map((b) => b.sha));
    const files: Record<string, string> = {};
    for (const b of blobs.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))) files[b.path] = this.blobHashes.get(b.sha)!;
    return { tag: tag.tag, commit: tag.commit, tree, files };
  }

  /** SHA-256 each blob not seen yet, read in one `git cat-file --batch`. Blobs shared between tags are hashed once. */
  private hashBlobs(ids: string[]): void {
    const todo = [...new Set(ids)].filter((id) => !this.blobHashes.has(id));
    if (todo.length === 0) return;
    const out = execFileSync("git", ["cat-file", "--batch"], { cwd: this.scratch, input: todo.join("\n") + "\n", maxBuffer: 1024 * 1024 * 1024 });
    let at = 0;
    for (const id of todo) {
      const eol = out.indexOf(0x0a, at);
      const header = out.subarray(at, eol).toString("utf-8").split(" ");
      if (header[0] !== id || header[1] !== "blob") throw new LockError(`${this.label}: could not read blob ${id}`);
      const size = Number(header[2]);
      const data = out.subarray(eol + 1, eol + 1 + size);
      this.blobHashes.set(id, `sha256:${createHash("sha256").update(data).digest("hex")}`);
      at = eol + 1 + size + 1;
    }
  }
}

export interface ComputedIndex {
  index: HashIndex;
  /** Tags whose entry came from the cache, unverified until one is adopted. */
  cached: Set<string>;
}

/**
 * The index of a template, from its tags. With `cache`, an entry is reused when
 * its tag still names the recorded commit; the others are fetched and
 * computed. `only` restricts the index to one tag (adopting at a tag the user
 * named).
 */
export function computeHashIndex(
  tags: TemplateTags,
  template: string,
  options: { pattern?: string; cache?: HashIndex; only?: string } = {},
): ComputedIndex {
  let remote = tags.listTags(options.pattern);
  if (options.only !== undefined) {
    remote = remote.filter((t) => t.tag === options.only);
    if (remote.length === 0) throw new LockError(`${tags.label} has no version tag ${options.only}`);
  }
  if (remote.length === 0) {
    throw new LockError(
      `${tags.label} has no tag that reads as a version${options.pattern ? ` and matches ${options.pattern}` : ""}; adopt-lineage matches against tagged releases`,
    );
  }
  if (options.cache && options.cache.template !== template) {
    throw new LockError(`the hash index is for ${options.cache.template}, not ${template}`);
  }
  const fromCache = new Map((options.cache?.tags ?? []).map((e) => [e.tag, e]));
  const cached = new Set<string>();
  const entries: HashIndexEntry[] = [];
  const toCompute = remote.filter((t) => {
    const hit = fromCache.get(t.tag);
    return !hit || hit.commit !== t.commit;
  });
  tags.fetchTags(toCompute.map((t) => t.tag));
  const computed = new Map(toCompute.map((t) => [t.tag, tags.entry(t)]));
  for (const t of remote) {
    if (computed.has(t.tag)) {
      // A tag without the template's directory has no entry.
      const own = computed.get(t.tag);
      if (own) entries.push(own);
    } else {
      entries.push(fromCache.get(t.tag)!);
      cached.add(t.tag);
    }
  }
  if (entries.length === 0) {
    throw new LockError(`${tags.label}: no version tag${options.only !== undefined ? ` ${options.only}` : ""} has the directory ${tags.member}`);
  }
  return { index: { indexVersion: HASH_INDEX_VERSION, template, tags: entries }, cached };
}
