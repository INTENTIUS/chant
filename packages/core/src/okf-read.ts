import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Declarable } from "./declarable";
import { splitFrontmatter } from "./okf";
import { parseYAML } from "./yaml";

/**
 * OKF bundle reader (#1864, design #1059, epic #1057) — the input half of
 * `./okf.ts`'s emitter: loads a project-authored knowledge bundle from disk
 * and binds its concepts to discovered entities.
 *
 * Tolerant to the letter of the OKF v0.2 spec (§11), the same posture
 * `okfConformanceProblems` enforces on the emit side: unknown `type` values
 * and extra frontmatter keys pass through untouched, a file with unparseable
 * or missing frontmatter is skipped with a warning, and nothing here ever
 * rejects the bundle — a missing knowledge directory included.
 */

const RESERVED_OKF_FILES = new Set(["index.md", "log.md"]);

/**
 * One authored concept document, parsed from a bundle. Deliberately thinner
 * than the emit side's internal `Concept` (`./okf.ts`) — this is what a
 * *reader* trusts, and per the #1059 design that is `type`/`title` plus the
 * single frontmatter key chant interprets, `binds`. Everything else an
 * author wrote rides along in {@link frontmatter} unexamined, so a consumer
 * that needs a project-specific key (a future `category`, say) can still
 * reach it without a reader change.
 */
export interface OkfConcept {
  /** Bundle-relative path (forward-slash separated), e.g. "decisions/public-assets.md". */
  path: string;
  /** The frontmatter `type`. May be empty — the reader never rejects a concept for it, unlike the emitter's conformance check. */
  type: string;
  /** Frontmatter `title`, when the author set one. */
  title?: string;
  /**
   * This concept's `binds` frontmatter key, normalized to a list — one name,
   * several, or `[]` for "declared no binding, and that's legitimate."
   * Structural-looking keys (`name`, `lexicon`, `kind`) are deliberately
   * *not* surfaced here or anywhere else on this type: the reader interprets
   * exactly `binds` (#1059's precedence-by-construction), so authored and
   * inferred knowledge cannot conflict at the fact level.
   */
  binds: string[];
  /** Every frontmatter key this concept's document carries, `binds` included, verbatim. */
  frontmatter: Record<string, unknown>;
  /** Markdown body (everything after the closing `---`), unchanged. */
  body: string;
}

/** A loaded OKF knowledge bundle: every authored concept found, reserved files already excluded. */
export interface OkfBundle {
  concepts: OkfConcept[];
}

/** `binds` accepts one name or a list (#1059); anything else is treated as "no binding" rather than rejecting the concept. */
function normalizeBinds(value: unknown): string[] {
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return [];
}

/** Recursively collect every `.md` file under `dir`, as bundle-relative (forward-slash) paths paired with their absolute path. */
async function findMarkdownFiles(dir: string): Promise<Array<{ relPath: string; fullPath: string }>> {
  const found: Array<{ relPath: string; fullPath: string }> = [];

  async function scan(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // unreadable directory: silently skip, same posture as findInfraFiles
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const relPath = relative(dir, fullPath).split(sep).join("/");
        found.push({ relPath, fullPath });
      }
    }
  }

  await scan(dir);
  return found;
}

/**
 * Load every authored concept from an OKF knowledge bundle directory.
 * `index.md`/`log.md` are skipped (reserved, by basename, at any depth —
 * matching `okfConformanceProblems`'s check on the emit side). A directory
 * that does not exist yields an empty bundle, not an error: the #1059 design
 * treats a missing `knowledge/` as "this project has none yet," the same
 * posture as a project with no lexicons configured.
 *
 * A file that fails to parse — no frontmatter block, unparseable YAML, or
 * frontmatter that isn't a mapping — is skipped with a `console.warn` and
 * does not affect any other file. Nothing here throws.
 */
export async function loadOkfBundle(dir: string): Promise<OkfBundle> {
  if (!existsSync(dir)) return { concepts: [] };

  const concepts: OkfConcept[] = [];
  for (const { relPath, fullPath } of await findMarkdownFiles(dir)) {
    if (RESERVED_OKF_FILES.has(relPath.split("/").pop()!)) continue;

    let content: string;
    try {
      content = await readFile(fullPath, "utf8");
    } catch {
      console.warn(`[chant] warning: knowledge bundle concept "${relPath}" could not be read, skipping`);
      continue;
    }

    const split = splitFrontmatter(content);
    if (!split) {
      console.warn(`[chant] warning: knowledge bundle concept "${relPath}" has no frontmatter block, skipping`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseYAML(split.frontmatter);
    } catch {
      console.warn(`[chant] warning: knowledge bundle concept "${relPath}" has unparseable frontmatter, skipping`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn(`[chant] warning: knowledge bundle concept "${relPath}" frontmatter is not a mapping, skipping`);
      continue;
    }

    const frontmatter = parsed as Record<string, unknown>;
    concepts.push({
      path: relPath,
      type: typeof frontmatter.type === "string" ? frontmatter.type : "",
      title: typeof frontmatter.title === "string" ? frontmatter.title : undefined,
      binds: normalizeBinds(frontmatter.binds),
      frontmatter,
      body: split.body,
    });
  }

  concepts.sort((a, b) => a.path.localeCompare(b.path));
  return { concepts };
}

/** {@link bindConcepts}'s result: bound concepts per entity, plus every binding that resolved nothing. */
export interface BindConceptsResult {
  /**
   * Bound concepts keyed by entity logical name — the same names that key
   * `DiscoveryResult.entities` (`./discovery/index.ts`). An entity with no
   * bound concepts is absent from the map, never present with `[]`.
   */
  bound: Map<string, OkfConcept[]>;
  /** Every `binds` entry that named no entity in `entities` — chant's own broken-link posture (#1059): a warning for the caller to surface (COR022, #1865), never a load failure. */
  unresolved: UnresolvedBinding[];
}

/** One `binds` entry that resolved to nothing. */
export interface UnresolvedBinding {
  /** The concept whose `binds` named this entity. */
  concept: OkfConcept;
  /** The unresolved logical name. */
  name: string;
}

/**
 * Resolve every concept's `binds` against a project's discovered entities.
 * `entities` is the same shape `./okf.ts`'s emitter takes, `DiscoveryResult`'s
 * own `entities` map — a bare logical name is unambiguous within one
 * discovery pass (#1059's "Rejected options" on binding ambiguity).
 *
 * A concept with no `binds` contributes to neither `bound` nor `unresolved`;
 * an unbound concept is legitimate, not an omission (a runbook, a decision
 * about the project as a whole).
 */
export function bindConcepts(bundle: OkfBundle, entities: Map<string, Declarable>): BindConceptsResult {
  const bound = new Map<string, OkfConcept[]>();
  const unresolved: UnresolvedBinding[] = [];

  for (const concept of bundle.concepts) {
    for (const name of concept.binds) {
      if (entities.has(name)) {
        if (!bound.has(name)) bound.set(name, []);
        bound.get(name)!.push(concept);
      } else {
        unresolved.push({ concept, name });
      }
    }
  }

  return { bound, unresolved };
}
