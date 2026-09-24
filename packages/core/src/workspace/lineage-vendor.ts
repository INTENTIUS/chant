/**
 * `chant vendor` over the lineage lock (#2540, ws-038).
 *
 * A vendored target is one lineage scope of kind `vendor`: copied, with no
 * parameters. `pull` updates it file by file through {@link applyUpstream}, so
 * local edits survive and a file both sides changed becomes a manual step.
 * `check` reports edits and fails on open manual steps.
 *
 * `vendor.json` is still read. A project whose lock has no vendor scopes and
 * which never ran `chant vendor migrate` keeps today's `vendor.json` behaviour
 * byte for byte (#2525 rule 2): this module loads only when a lock exists or
 * `migrate` runs.
 */

import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MANIFEST_FILE,
  contentHash,
  loadManifest,
  readTarget,
  resolveVendorSource,
  type VendorEntry,
} from "../cli/commands/vendor";
import { LOCK_FILE, LockError, emptyLock, fileEntries, readLock, scopeKey, scopeStatus, writeLock, type Lineage, type LineageLock, type ManualStep } from "./lineage-lock";
import { applyUpstream } from "./lineage-update";

/** The template id a vendor source is known by. */
function vendorTemplateId(source: VendorEntry["source"]): string {
  if (source.type === "local") return `local:${source.path}`;
  return source.subpath ? `${source.url}#${source.subpath}` : source.url;
}

/** Vendor scopes in the lock, by scope key. */
export function vendorScopes(lock: LineageLock): Array<[string, Lineage]> {
  return Object.entries(lock.scopes).filter(([, l]) => l.kind === "vendor");
}

function vendorSource(lineage: Lineage): VendorEntry["source"] {
  const s = lineage.source;
  if (s.type === "local" || s.type === "archive") return s;
  throw new LockError(`vendor scope "${lineage.name}" has a ${s.type} source; vendor scopes take local or archive sources`);
}

// ── pull ─────────────────────────────────────────────────────────────────────

export interface LockedPull {
  name: string;
  target: string;
  digest: string;
  fileCount: number;
  written: number;
  kept: number;
  removed: number;
  manualSteps: ManualStep[];
}

/** Pull the lock's vendor scopes (or just `only`). Writes the lock. */
export async function pullLockedScopes(root: string, only?: string): Promise<LockedPull[]> {
  const lock = readLock(root) ?? emptyLock();
  const pulled: LockedPull[] = [];
  for (const [scope, lineage] of vendorScopes(lock)) {
    if (only && lineage.name !== only) continue;
    const files = await resolveVendorSource(vendorSource(lineage), root);
    const result = applyUpstream(resolve(root, scope), lineage, files);
    pulled.push({
      name: lineage.name ?? scope,
      target: scope,
      digest: lineage.address!.digest,
      fileCount: files.size,
      written: result.written.length,
      kept: result.kept.length,
      removed: result.removed.length,
      manualSteps: result.manualSteps,
    });
  }
  if (pulled.length > 0) writeLock(root, lock);
  return pulled;
}

export function formatLockedPull(p: LockedPull): string {
  const lines = [`  ${p.name} → ${p.target} (${p.fileCount} file(s), ${p.digest.slice(0, 19)}…)`];
  if (p.kept > 0) lines.push(`    kept ${p.kept} locally edited file(s)`);
  for (const s of p.manualSteps) lines.push(`    manual step: ${s.path} (${s.reason})`);
  return lines.join("\n");
}

// ── check ────────────────────────────────────────────────────────────────────

export type LockedCheckStatus = "ok" | "customised" | "manual" | "unpinned" | "missing";

export interface LockedCheck {
  name: string;
  status: LockedCheckStatus;
  customised: string[];
  manualSteps: ManualStep[];
}

/** Check each vendor scope in the lock against the tree. */
export function checkLockedScopes(root: string): LockedCheck[] {
  const lock = readLock(root);
  if (!lock) return [];
  const out: LockedCheck[] = [];
  for (const [scope, lineage] of vendorScopes(lock)) {
    const name = lineage.name ?? scope;
    if (!lineage.address) {
      out.push({ name, status: "unpinned", customised: [], manualSteps: [] });
      continue;
    }
    if (!existsSync(resolve(root, scope))) {
      out.push({ name, status: "missing", customised: [], manualSteps: [] });
      continue;
    }
    const st = scopeStatus(root, scope, lineage);
    const customised = [...st.customised, ...st.missing].sort();
    const status: LockedCheckStatus = lineage.manualSteps.length > 0 ? "manual" : customised.length > 0 ? "customised" : "ok";
    out.push({ name, status, customised, manualSteps: lineage.manualSteps });
  }
  return out;
}

export function formatLockedCheck(c: LockedCheck): string {
  switch (c.status) {
    case "ok":
      return `  ${c.name}: ok`;
    case "customised":
      return `  ${c.name}: ok, ${c.customised.length} file(s) edited locally`;
    case "manual":
      return [
        `  ${c.name}: ${c.manualSteps.length} manual step(s) open`,
        ...c.manualSteps.map((s) => `    ${s.path} (${s.reason})`),
      ].join("\n");
    case "unpinned":
      return `  ${c.name}: unpinned — run \`chant vendor pull\` to record it`;
    case "missing":
      return `  ${c.name}: MISSING — target not found; run \`chant vendor pull\``;
  }
}

/** Whether a check result fails the check the way drift does for `vendor.json`. */
export function lockedCheckFails(c: LockedCheck): boolean {
  return c.status === "manual" || c.status === "missing";
}

// ── migrate ──────────────────────────────────────────────────────────────────

export interface MigrateResult {
  migrated: Array<{ name: string; target: string; files: number; pinned: boolean }>;
  lockCreated: boolean;
}

/**
 * Move every `vendor.json` entry into the lock as a vendor scope, then delete
 * `vendor.json`. An entry's checksum becomes the scope's digest.
 *
 * Per-file merge bases come from the target when it still matches the
 * checksum. When it has been edited, they come from the source instead, which
 * must still hash to the checksum; otherwise the pinned content is gone and the
 * entry is refused. Nothing is written unless every entry migrates.
 */
export async function migrateVendorManifest(root: string): Promise<MigrateResult> {
  const { manifest, path: manifestPath } = loadManifest(root);
  const existing = readLock(root);
  const lock = existing ?? emptyLock();
  const migrated: MigrateResult["migrated"] = [];
  const names = new Set(vendorScopes(lock).map(([, l]) => l.name));

  for (const entry of manifest.vendored) {
    const scope = scopeKey(entry.target);
    if (scope === ".") throw new LockError(`vendor entry "${entry.name}" targets the project root; a vendor scope must be a subdirectory`);
    if (lock.scopes[scope]) throw new LockError(`vendor entry "${entry.name}": ${LOCK_FILE} already has a scope at ${scope}`);
    if (names.has(entry.name)) throw new LockError(`vendor entry "${entry.name}": ${LOCK_FILE} already has a vendor scope with that name`);
    names.add(entry.name);

    let files: Lineage["files"] = {};
    if (entry.checksum) {
      const targetAbs = resolve(root, entry.target);
      const local = readTarget(targetAbs);
      if (local.size > 0 && contentHash(local) === entry.checksum) {
        files = fileEntries(local);
      } else {
        const source = await resolveVendorSource(entry.source, root);
        if (contentHash(source) !== entry.checksum) {
          throw new LockError(
            `vendor entry "${entry.name}": ${entry.target} has been edited and its source no longer matches the recorded checksum, so the pinned files cannot be recovered. Run \`chant vendor pull ${entry.name}\` first (it overwrites ${entry.target}), or restore the pinned content.`,
          );
        }
        files = fileEntries(source);
      }
    }

    lock.scopes[scope] = {
      kind: "vendor",
      name: entry.name,
      template: vendorTemplateId(entry.source),
      source: entry.source,
      ...(entry.ref !== undefined ? { ref: entry.ref } : {}),
      address: entry.checksum ? { digest: entry.checksum } : null,
      parameters: {},
      migrations: [],
      files,
      manualSteps: [],
    };
    migrated.push({ name: entry.name, target: scope, files: Object.keys(files).length, pinned: !!entry.checksum });
  }

  writeLock(root, lock);
  rmSync(manifestPath);
  return { migrated, lockCreated: existing === null };
}

/** Whether `vendor.json` sits next to the lock. */
export function manifestPresent(root: string): boolean {
  return existsSync(join(root, MANIFEST_FILE));
}
