/**
 * `chant vendor` — pull reusable patterns (composites as source, Ops, init
 * templates, example skeletons) from a remote source into your own repo, pinned
 * and auditable.
 *
 * This is for patterns you copy in and **own/adapt**, recorded in a manifest
 * (`vendor.json`) with a checksum so provenance is verifiable. It is NOT a
 * package manager: lexicons stay npm dependencies (the typed API you import,
 * never edit). Vendoring exists for the source npm handles badly — code you want
 * in-repo, reviewable in diffs, and adaptable.
 *
 * Reuses the existing fetch/extract infra (`codegen/fetch.ts`); the only new
 * machinery is the manifest + copy-to-repo + checksum.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { fetchWithRetry, extractFromTar, extractFromZip } from "../../codegen/fetch";

// ── Manifest schema ─────────────────────────────────────────────────────────

const SourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local"), path: z.string().min(1) }),
  z.object({ type: z.literal("archive"), url: z.string().url(), subpath: z.string().optional() }),
]);

const EntrySchema = z.object({
  /** Stable identity for the vendored artifact (used by `pull <name>`). */
  name: z.string().min(1),
  source: SourceSchema,
  /** Path in your repo to write the pulled content. */
  target: z.string().min(1),
  /** The pin — a git tag / version label, for provenance (informational). */
  ref: z.string().optional(),
  /** sha256 of the pulled content. Written by `pull`, verified by `check`. */
  checksum: z.string().optional(),
  /** Only "pin" (explicit-bump) is supported; floating refs are out of scope. */
  updatePolicy: z.literal("pin").optional(),
});

export const VendorManifestSchema = z.object({
  vendored: z.array(EntrySchema),
});

export type VendorEntry = z.infer<typeof EntrySchema>;
export type VendorManifest = z.infer<typeof VendorManifestSchema>;

export const MANIFEST_FILE = "vendor.json";

// ── Content hashing ───────────────────────────────────────────────────────��─

/**
 * Deterministic sha256 over a file set — independent of fetch/extract order.
 * Hashes each `path\0content\0` in sorted-path order.
 */
export function contentHash(files: Map<string, Buffer>): string {
  const h = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    h.update(path);
    h.update("\0");
    h.update(files.get(path)!);
    h.update("\0");
  }
  return `sha256:${h.digest("hex")}`;
}

// ── Source resolution → a { relpath → bytes } file set ──────────────────────

/** Walk a local directory into a relpath→bytes map (or a single file). */
function readLocal(absPath: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const stat = statSync(absPath);
  if (stat.isFile()) {
    files.set(absPath.split(sep).pop()!, readFileSync(absPath));
    return files;
  }
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files.set(relative(absPath, full).split(sep).join("/"), readFileSync(full));
      }
    }
  };
  walk(absPath);
  return files;
}

/** Fetch + extract an archive (tar.gz/tgz/zip), scoped to an optional subpath. */
async function readArchive(url: string, subpath?: string): Promise<Map<string, Buffer>> {
  const resp = await fetchWithRetry(url);
  const bytes = new Uint8Array(await resp.arrayBuffer());

  let raw: Map<string, Buffer>;
  if (url.endsWith(".zip")) {
    raw = await extractFromZip(Buffer.from(bytes));
  } else {
    // .tar.gz / .tgz — gunzip then untar (matches fetchAndExtractTar).
    const { gunzipSync } = await import("fflate");
    raw = extractFromTar(gunzipSync(bytes));
  }

  return scopeArchiveFiles(raw, subpath);
}

/**
 * Normalize an extracted archive: strip the single top-level wrapper directory
 * (e.g. "repo-main/") that archives commonly add, then scope to `subpath`.
 * Pure — separated from the network fetch so the scoping is unit-testable.
 */
export function scopeArchiveFiles(
  raw: Map<string, Buffer>,
  subpath?: string,
): Map<string, Buffer> {
  const prefix = subpath ? subpath.replace(/^\/+|\/+$/g, "") + "/" : "";
  const files = new Map<string, Buffer>();
  for (const [name, data] of raw) {
    const slash = name.indexOf("/");
    const rel = slash >= 0 ? name.slice(slash + 1) : name;
    if (!rel || !rel.startsWith(prefix)) continue;
    const local = rel.slice(prefix.length);
    if (local) files.set(local, data);
  }
  return files;
}

async function resolveSource(entry: VendorEntry, manifestDir: string): Promise<Map<string, Buffer>> {
  if (entry.source.type === "local") {
    const abs = resolve(manifestDir, entry.source.path);
    if (!existsSync(abs)) throw new Error(`local source not found: ${entry.source.path}`);
    return readLocal(abs);
  }
  return readArchive(entry.source.url, entry.source.subpath);
}

// ── File I/O ────────────────────────────────────────────────────────────────

function writeFiles(targetDir: string, files: Map<string, Buffer>): void {
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true });
  for (const [rel, data] of files) {
    const full = join(targetDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
}

function readTarget(targetDir: string): Map<string, Buffer> {
  if (!existsSync(targetDir)) return new Map();
  return readLocal(targetDir);
}

// ── Manifest load/save ────────────────────────────────────────────────────��─

export function loadManifest(manifestDir: string): { manifest: VendorManifest; path: string } {
  const path = join(manifestDir, MANIFEST_FILE);
  if (!existsSync(path)) {
    throw new Error(`no ${MANIFEST_FILE} found in ${manifestDir}`);
  }
  const parsed = VendorManifestSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
  if (!parsed.success) {
    throw new Error(`invalid ${MANIFEST_FILE}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return { manifest: parsed.data, path };
}

function saveManifest(path: string, manifest: VendorManifest): void {
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

// ── pull ─────────────────────────────────────────────────────────────────��──

export interface VendorPullResult {
  success: boolean;
  pulled: Array<{ name: string; target: string; checksum: string; fileCount: number }>;
  output: string;
}

/**
 * Pull each vendored entry (or just `only`): resolve the source, write it into
 * `target`, and record the content checksum back into the manifest.
 */
export async function vendorPull(manifestDir: string, only?: string): Promise<VendorPullResult> {
  const { manifest, path } = loadManifest(manifestDir);
  const entries = only ? manifest.vendored.filter((e) => e.name === only) : manifest.vendored;
  if (only && entries.length === 0) {
    return { success: false, pulled: [], output: `no vendored entry named "${only}"` };
  }

  const pulled: VendorPullResult["pulled"] = [];
  for (const entry of entries) {
    const files = await resolveSource(entry, manifestDir);
    const checksum = contentHash(files);
    writeFiles(resolve(manifestDir, entry.target), files);
    entry.checksum = checksum;
    pulled.push({ name: entry.name, target: entry.target, checksum, fileCount: files.size });
  }
  saveManifest(path, manifest);

  const output = pulled
    .map((p) => `  ${p.name} → ${p.target} (${p.fileCount} file(s), ${p.checksum.slice(0, 19)}…)`)
    .join("\n");
  return { success: true, pulled, output };
}

// ── check ────────────────────────────────────────────────────────────────��──

export interface VendorCheckResult {
  success: boolean;
  /** True if any vendored target diverged from its recorded checksum. */
  drift: boolean;
  entries: Array<{ name: string; status: "ok" | "drifted" | "unpinned" | "missing" }>;
  output: string;
}

/**
 * Verify each target's working copy against its recorded checksum. Editing
 * vendored files is allowed — `check` only reports that they diverged from the
 * pin. The caller decides whether drift is fatal (CI) or a warning (local).
 */
export function vendorCheck(manifestDir: string): VendorCheckResult {
  const { manifest } = loadManifest(manifestDir);
  const entries: VendorCheckResult["entries"] = [];
  let drift = false;

  for (const entry of manifest.vendored) {
    const targetAbs = resolve(manifestDir, entry.target);
    if (!entry.checksum) {
      entries.push({ name: entry.name, status: "unpinned" });
      continue;
    }
    if (!existsSync(targetAbs)) {
      entries.push({ name: entry.name, status: "missing" });
      drift = true;
      continue;
    }
    const actual = contentHash(readTarget(targetAbs));
    if (actual === entry.checksum) {
      entries.push({ name: entry.name, status: "ok" });
    } else {
      entries.push({ name: entry.name, status: "drifted" });
      drift = true;
    }
  }

  const label: Record<string, string> = {
    ok: "ok",
    drifted: "DRIFTED (working copy differs from the pin)",
    unpinned: "unpinned — run `chant vendor pull` to record a checksum",
    missing: "MISSING — target not found; run `chant vendor pull`",
  };
  const output = entries.map((e) => `  ${e.name}: ${label[e.status]}`).join("\n");
  return { success: !drift, drift, entries, output };
}
