/**
 * The lineage lock, `.chant/workspace.lock.json` (#2524 D9, #2540).
 *
 * The lock records where a project's files came from. It holds one lineage per
 * scope, keyed by the scope's directory relative to the lock's root:
 *
 * - a project made by `chant init --from <repo>@<ref>` or
 *   `chant init --template <name>` has one scope, `"."`;
 * - each `chant vendor` target is a scope of kind `vendor` (copied, no
 *   parameters), which replaces its entry in `vendor.json` (ws-038).
 *
 * A lineage names its template, the content address the files came from, the
 * parameter values used, the migrations applied so far and, per file, a class
 * (`owned`, `generated` or `seed`) and the hash the file had when chant wrote
 * it. That hash is the merge base: a file whose content still has it was not
 * edited, and an update may replace it. A file that differs is the project's
 * own, and an update that also changed it becomes a manual step instead of an
 * overwrite. `chant workspace upgrade` (#2550) builds on exactly this.
 *
 * Lineage works for a plain project (#2525 rule 4, ws-013): the lock sits at
 * the project root and needs no `chant.workspace.json`. Like everything under
 * `workspace/`, this module loads only when a lock exists or a command that
 * writes one runs, never on a level-0 path (#2525 rule 5).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { z } from "zod";
import { WorkspaceReadError } from "./declaration";
import { classifyFile, declaredFilesFor, type DeclaredFiles } from "./generated-files";

/** Where the lock lives, relative to the project (or workspace) root. */
export const LOCK_FILE = ".chant/workspace.lock.json";

/** The format this chant reads and writes. A reader refuses a newer one. */
export const LOCK_VERSION = 1;

// ── Schema ───────────────────────────────────────────────────────────────────

const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 hex>");

/**
 * How an update treats a file (D9, D14).
 *
 * - `owned`: from the template; replaced by an update when it still has its
 *   recorded hash, merged or turned into a manual step when it does not.
 * - `generated`: rebuilt by `command` rather than merged.
 * - `seed`: written once at init and never touched again.
 */
export const FILE_CLASSES = ["owned", "generated", "seed"] as const;
export type FileClass = (typeof FILE_CLASSES)[number];

const LockFileEntrySchema = z
  .object({
    class: z.enum(FILE_CLASSES),
    /** The file's hash as chant last wrote it: the merge base. */
    sha256: Sha256,
    /** For `generated` files, the command that rebuilds them. */
    command: z.string().min(1).optional(),
  })
  .strict();

/** Where a template's files are fetched from. */
const SourceSchema = z.discriminatedUnion("type", [
  /** A git repository at a ref, optionally one directory of it (`#<member>`). */
  z.object({ type: z.literal("git"), repo: z.string().min(1), url: z.string().min(1), path: z.string().optional() }).strict(),
  /** A lexicon's `initTemplates`, as `chant init --lexicon <lexicon> --template <template>` renders them. */
  z.object({ type: z.literal("lexicon"), lexicon: z.string().min(1), template: z.string().min(1) }).strict(),
  /** `chant vendor` sources, unchanged from `vendor.json`. */
  z.object({ type: z.literal("local"), path: z.string().min(1) }).strict(),
  z.object({ type: z.literal("archive"), url: z.string().url(), subpath: z.string().optional() }).strict(),
]);
export type LineageSource = z.infer<typeof SourceSchema>;

/**
 * What the files came from, precisely enough to fetch or render them again.
 * `digest` is always present: the content hash of the file set as chant wrote
 * it (the same hash `vendor.json` called `checksum`). A git source adds the
 * commit and the tree of the scope's directory; a lexicon template adds the
 * package and chant versions that rendered it.
 */
const AddressSchema = z
  .object({
    digest: Sha256,
    commit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
    tree: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
    package: z.string().optional(),
    version: z.string().nullable().optional(),
    chant: z.string().optional(),
  })
  .strict();

/**
 * Why an update left a file alone. Closed: a reader may switch on it.
 *
 * - `changed-locally`: both the project and the source changed the file.
 * - `deleted-locally`: the project deleted a file the source changed.
 * - `exists-locally`: the source added a file the project already has.
 * - `removed-upstream`: the source removed a file the project changed.
 */
export const MANUAL_STEP_REASONS = ["changed-locally", "deleted-locally", "exists-locally", "removed-upstream"] as const;
export type ManualStepReason = (typeof MANUAL_STEP_REASONS)[number];

const ManualStepSchema = z
  .object({
    path: z.string().min(1),
    reason: z.enum(MANUAL_STEP_REASONS),
    /** The source's version of the file, or null when the source removed it. */
    upstream: Sha256.nullable(),
  })
  .strict();
export type ManualStep = z.infer<typeof ManualStepSchema>;

const LineageSchema = z
  .object({
    kind: z.enum(["template", "vendor"]),
    /** For a vendor scope, the name `chant vendor pull <name>` takes. */
    name: z.string().min(1).optional(),
    /** Stable identity of the source template, e.g. `github.com/acme/starter#service` or `lexicon:aws/node-pipeline`. */
    template: z.string().min(1),
    source: SourceSchema,
    /** The pin as the user wrote it: a git ref, a tag or a version label. */
    ref: z.string().optional(),
    address: AddressSchema.nullable(),
    /** The parameter values the template was instantiated with. Always empty for vendor scopes. */
    parameters: z.record(z.string(), z.unknown()),
    /** Migrations applied since instantiation (#2550). */
    migrations: z.array(z.string()),
    /** Per file, relative to the scope directory, in sorted order. */
    files: z.record(z.string(), LockFileEntrySchema),
    manualSteps: z.array(ManualStepSchema),
  })
  .strict();
export type Lineage = z.infer<typeof LineageSchema>;

const LockSchema = z
  .object({
    lockVersion: z.literal(LOCK_VERSION),
    scopes: z.record(z.string(), LineageSchema),
  })
  .strict();
export type LineageLock = z.infer<typeof LockSchema>;

// ── Hashes ───────────────────────────────────────────────────────────────────

/** `sha256:<hex>` of one file's bytes. */
export function fileHash(data: Buffer | string): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/**
 * The content hash of a file set, independent of order: sha256 over each
 * `path\0content\0` in sorted-path order. Identical to `vendor.json`'s
 * `checksum`, so a migrated entry keeps its digest.
 */
export function contentDigest(files: Map<string, Buffer>): string {
  const h = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    h.update(path);
    h.update("\0");
    h.update(files.get(path)!);
    h.update("\0");
  }
  return `sha256:${h.digest("hex")}`;
}

// ── Scope paths ──────────────────────────────────────────────────────────────

/** Normalise a scope directory to the lock's key form: posix, relative, `.` for the root. */
export function scopeKey(dir: string): string {
  const norm = posix.normalize(dir.split("\\").join("/")).replace(/\/+$/, "");
  if (norm === "" || norm === ".") return ".";
  if (norm.startsWith("/") || norm === ".." || norm.startsWith("../")) {
    throw new LockError(`scope "${dir}" must be a path inside the project`);
  }
  return norm.replace(/^\.\//, "");
}

// ── Read and write ───────────────────────────────────────────────────────────

export class LockError extends Error {
  override name = "LockError";
}

export function lockPath(root: string): string {
  return join(root, LOCK_FILE);
}

export function lockExists(root: string): boolean {
  return existsSync(lockPath(root));
}

export function emptyLock(): LineageLock {
  return { lockVersion: LOCK_VERSION, scopes: {} };
}

/** Read and validate the lock at `root`, or return null when there is none. */
export function readLock(root: string): LineageLock | null {
  const path = lockPath(root);
  if (!existsSync(path)) return null;
  return parseLock(readFileSync(path, "utf-8"));
}

/** Validate a lock's text, such as one read from a revision (`chant workspace check --at`, #2536). */
export function parseLock(text: string): LineageLock {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new LockError(`${LOCK_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const version = (raw as { lockVersion?: unknown } | null)?.lockVersion;
  if (typeof version === "number" && version > LOCK_VERSION) {
    throw new LockError(`${LOCK_FILE} has lockVersion ${version}; this chant reads up to ${LOCK_VERSION}. Upgrade chant.`);
  }
  const parsed = LockSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LockError(
      `invalid ${LOCK_FILE}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  for (const key of Object.keys(parsed.data.scopes)) {
    if (scopeKey(key) !== key) throw new LockError(`invalid ${LOCK_FILE}: scope "${key}" is not in normal form ("${scopeKey(key)}")`);
  }
  return parsed.data;
}

/** Keys sorted at every level that is a map, so the file diffs cleanly. */
function canonical(lock: LineageLock): LineageLock {
  const scopes: Record<string, Lineage> = {};
  for (const key of Object.keys(lock.scopes).sort()) {
    const s = lock.scopes[key];
    const files: Lineage["files"] = {};
    for (const f of Object.keys(s.files).sort()) files[f] = s.files[f];
    scopes[key] = {
      kind: s.kind,
      ...(s.name !== undefined ? { name: s.name } : {}),
      template: s.template,
      source: s.source,
      ...(s.ref !== undefined ? { ref: s.ref } : {}),
      address: s.address,
      parameters: s.parameters,
      migrations: s.migrations,
      files,
      manualSteps: [...s.manualSteps].sort((a, b) => a.path.localeCompare(b.path)),
    };
  }
  return { lockVersion: lock.lockVersion, scopes };
}

/** Serialise the lock deterministically. */
export function renderLock(lock: LineageLock): string {
  return JSON.stringify(canonical(lock), null, 2) + "\n";
}

export function writeLock(root: string, lock: LineageLock): void {
  const checked = LockSchema.parse(lock);
  const path = lockPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderLock(checked));
}

// ── Building a lineage ───────────────────────────────────────────────────────

/**
 * The class a file gets (D14), from the same list the drift check reads
 * (`generated-files.ts`): a member's declared generated files, passed as
 * `declared`, then the implicit rules. Skills that `chant update` rewrites
 * are generated, `.mcp.json` is a seed, a hand-written entry and the rest are
 * owned. `.chant/types/` is ignored, and {@link fileEntries} leaves it out.
 */
export function defaultFileClass(path: string, declared?: DeclaredFiles): { class: FileClass; command?: string } {
  const c = classifyFile(path, declared);
  if (c.class === "generated") return { class: "generated", command: c.command };
  return { class: c.class === "ignored" ? "owned" : c.class };
}

/**
 * The declared generated files for the scope directory `absDir`, from the
 * workspace declaration above it, if any (#2541). A declaration that can't
 * be read is a {@link LockError}, never an empty list.
 */
export function declaredFilesAt(absDir: string): DeclaredFiles {
  try {
    return declaredFilesFor(absDir);
  } catch (err) {
    if (err instanceof WorkspaceReadError) throw new LockError(`${err.code}: ${err.describe()}`);
    throw err;
  }
}

/** Per-file entries for a file set, each with its default class. Ignored paths (`.chant/types/`) are left out. */
export function fileEntries(files: Map<string, Buffer>, declared?: DeclaredFiles): Lineage["files"] {
  const out: Lineage["files"] = {};
  for (const path of [...files.keys()].sort()) {
    if (classifyFile(path, declared).class === "ignored") continue;
    out[path] = { ...defaultFileClass(path, declared), sha256: fileHash(files.get(path)!) };
  }
  return out;
}

// ── Status against the working tree ──────────────────────────────────────────

export interface ScopeStatus {
  scope: string;
  lineage: Lineage;
  /** Files whose content no longer has the recorded hash (generated files excluded). */
  customised: string[];
  /** Files recorded in the lock and missing from the tree. */
  missing: string[];
}

/** Compare each recorded file of a scope with the tree under `root`. */
export function scopeStatus(root: string, scope: string, lineage: Lineage): ScopeStatus {
  const customised: string[] = [];
  const missing: string[] = [];
  for (const [path, entry] of Object.entries(lineage.files)) {
    // A generated file is rebuilt by its command, never merged, and is often
    // gitignored (`skills/`), so neither an edit nor its absence means anything.
    if (entry.class === "generated") continue;
    const abs = join(root, scope, path);
    if (!existsSync(abs)) {
      missing.push(path);
      continue;
    }
    if (fileHash(readFileSync(abs)) !== entry.sha256) customised.push(path);
  }
  return { scope, lineage, customised, missing };
}

/**
 * Close a manual step: the file as it stands is the project's resolution, and
 * the source's version becomes its new merge base. For a file the source
 * removed, the file leaves the lineage and stays in the tree as the project's.
 */
export function resolveManualStep(lock: LineageLock, filePath: string): { scope: string; step: ManualStep } | null {
  const norm = scopeKey(filePath);
  // Deepest scope first: a vendor scope inside the root scope owns its files.
  const scopes = Object.entries(lock.scopes).sort((a, b) => b[0].length - a[0].length);
  for (const [scope, lineage] of scopes) {
    const prefix = scope === "." ? "" : `${scope}/`;
    if (prefix && !norm.startsWith(prefix)) continue;
    const rel = norm.slice(prefix.length);
    const index = lineage.manualSteps.findIndex((s) => s.path === rel);
    if (index < 0) continue;
    const [step] = lineage.manualSteps.splice(index, 1);
    if (step.upstream === null) {
      delete lineage.files[rel];
    } else {
      const prior = lineage.files[rel];
      lineage.files[rel] = { ...(prior ?? defaultFileClass(rel)), sha256: step.upstream };
    }
    return { scope, step };
  }
  return null;
}
