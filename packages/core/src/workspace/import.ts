/**
 * `chant workspace import`: bring an export back into the workspace it came
 * from (#2552, #2524 D10, requirements X3 and X5, ws-004, ws-073).
 *
 * The source is the export member, or a directory holding a copy of an
 * export, such as the repository a hosted copy was kept in. Its
 * `.chant/export.json` names the workspace and the members that went, and the
 * hash each file had on both sides when it went: the merge base.
 *
 * For each file, three hashes decide. A file the copy did not change is left
 * alone. A file the copy changed is written when the workspace did not
 * change it since the export. A file both changed differently is a conflict,
 * and any conflict refuses the whole import, which then writes nothing. The
 * same holds for removed and added files. Only paths inside the members that
 * went, and the record directories of a whole export, are written: a copy
 * that holds anything else is refused, so an import never writes into another
 * member.
 *
 * Host values switch back (X3): the host-bound values the export recorded
 * are put back in the files the lineage lists, and in the lock. Each lineage
 * scope merges the same way as a file, with the scope's digest as the base.
 *
 * Every write is recorded in `.chant/returns/<id>.json` (./returns.ts). When
 * the copy is a git repository of its own, each written file also carries the
 * commit that last changed it there, with the original signature, and the
 * tree objects that tie that commit to the bytes. Records keep their seals,
 * since their bytes are copied as they are.
 *
 * Last, the export member is written again from the workspace as it now
 * stands (the default), or removed with its declaration entry (`--remove`).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { readDeclaration, type Declaration } from "./declaration";
import {
  EXPORT_MANIFEST,
  ExportError,
  exportMember,
  exportWorkspace,
  gitTopOf,
  isLockPath,
  lineageDigest,
  listFiles,
  lockDir,
  rawDeclaration,
  readManifestAt,
  scopedPath,
  switchHostValues,
  under,
  type ExportManifest,
  type ExportResult,
} from "./export";
import { fileHash, LOCK_FILE, parseLock, renderLock, type LineageLock } from "./lineage-lock";
import { buildOrigin, originSigners, RETURNS_DIR, writeReturn, type ReturnRecord } from "./returns";
import { workingTree } from "./tree";

export interface ImportOptions {
  /** The workspace root. */
  root: string;
  /** The returned copy's directory. Absent: the export member. */
  from?: string;
  /** Remove the export member and its declaration entry, rather than writing it again. */
  remove?: boolean;
  dryRun?: boolean;
}

export interface ImportConflict {
  path: string;
  reason: string;
}

export interface ImportResult {
  /** The export the copy started from. */
  export: string;
  /** The copy's directory, as given or the export member's. */
  from: string;
  written: string[];
  removed: string[];
  /** Locks changed, by path. */
  locks: string[];
  /** Paths whose host-bound values were switched back. */
  hostValues: string[];
  conflicts: ImportConflict[];
  /** Paths in the copy that are outside every member that went. */
  outside: string[];
  /** The return record written, relative to the workspace root, or null when nothing changed or for a dry run. */
  returnRecord: string | null;
  return: ReturnRecord | null;
  /** What happened to the export member: written again, removed, or left (nothing changed, a dry run, or a conflict). */
  member: { name: string; action: "regenerated" | "removed" | "left"; note?: string } | null;
  applied: boolean;
}

/** Paths the copy may hold besides member and record files. */
function ignoredInCopy(path: string): boolean {
  return path === EXPORT_MANIFEST || path === "chant.workspace.json" || path === "chant.workspace.jsonc" || path.startsWith(`${RETURNS_DIR}/`);
}

function readOr(abs: string): Buffer | undefined {
  return existsSync(abs) ? readFileSync(abs) : undefined;
}

/** Plan the import, and apply it unless `dryRun` or a conflict. Throws an {@link ExportError}. */
export async function importWorkspace(o: ImportOptions): Promise<ImportResult> {
  const root = resolve(o.root);
  const decl = readDeclaration(workingTree(root));
  const fromDir = o.from !== undefined ? resolve(o.from) : join(root, exportMember(decl).dir);
  const manifest = readManifestAt(fromDir);
  if (!manifest) throw new ExportError(`${fromDir} holds no ${EXPORT_MANIFEST}: it is not an export`);
  if (manifest.from.workspace !== decl.name) {
    throw new ExportError(`the export came from workspace ${manifest.from.workspace}, and this one is ${decl.name}`);
  }
  const memberDirs = manifest.members.map((name) => {
    const m = decl.members.find((x) => x.name === name);
    if (!m) throw new ExportError(`member ${name} went with the export, and this workspace no longer declares it`);
    return m.dir;
  });
  const allowed = [...memberDirs, ...manifest.dirs];
  const others = decl.members.filter((m) => !manifest.members.includes(m.name) && m.dir !== ".");

  // The copy's files and locks.
  const copyFiles = new Map<string, Buffer>();
  const copyLocks = new Map<string, LineageLock>();
  const outside: string[] = [];
  for (const path of listFiles(fromDir)) {
    if (ignoredInCopy(path)) continue;
    if (path === LOCK_FILE) {
      copyLocks.set(path, parseLock(readFileSync(join(fromDir, path), "utf-8")));
      continue;
    }
    if (!allowed.some((d) => under(path, d)) || others.some((m) => under(path, m.dir))) {
      outside.push(path);
      continue;
    }
    if (isLockPath(path)) copyLocks.set(path, parseLock(readFileSync(join(fromDir, path), "utf-8")));
    else copyFiles.set(path, readFileSync(join(fromDir, path)));
  }

  // Each scope's digest as the copy holds it, before host values go back.
  const copyDigests = new Map<string, string>();
  for (const [path, lock] of copyLocks) for (const [scope, lineage] of Object.entries(lock.scopes)) copyDigests.set(`${path}#${scope}`, lineageDigest(lineage));

  // Host values back (X3), in the files and in each lock.
  const exportForm = new Map(copyFiles);
  const hostValues = new Set<string>();
  for (const [path, lock] of copyLocks) {
    for (const [scope, lineage] of Object.entries(lock.scopes)) {
      const values = manifest.hostValues[`${path}#${scope}`];
      if (!values) continue;
      const back = Object.fromEntries(Object.entries(values).map(([n, v]) => [n, { from: v.export, to: v.host }]));
      for (const p of switchHostValues(lineage, lockDir(path), scope, back, copyFiles)) hostValues.add(p);
    }
  }

  const conflicts: ImportConflict[] = [];
  const writes = new Map<string, Buffer>();
  const removes: string[] = [];
  for (const path of [...new Set([...Object.keys(manifest.files), ...copyFiles.keys()])].sort()) {
    if (!allowed.some((d) => under(path, d))) continue;
    const base = manifest.files[path];
    const copy = exportForm.get(path);
    const changedThere = copy === undefined ? base !== undefined : base === undefined || fileHash(copy) !== base.export;
    if (!changedThere) continue;
    const here = readOr(join(root, path));
    const changedHere = here === undefined ? base !== undefined : base === undefined || fileHash(here) !== base.host;
    if (copy === undefined) {
      if (here === undefined) continue;
      if (changedHere) conflicts.push({ path, reason: "the copy removed it, and it changed here since the export" });
      else removes.push(path);
      continue;
    }
    const target = copyFiles.get(path)!;
    if (here !== undefined && here.equals(target)) continue;
    if (changedHere) {
      conflicts.push({ path, reason: here === undefined ? "the copy changed it, and it was removed here since the export" : base === undefined ? "the copy added it, and a different file was added here" : "the copy and this workspace both changed it since the export" });
      continue;
    }
    writes.set(path, target);
  }

  // Locks, scope by scope.
  const lockWrites = new Map<string, LineageLock>();
  for (const path of [...new Set([...Object.keys(manifest.locks), ...copyLocks.keys()])].sort()) {
    const there = copyLocks.get(path);
    const hereText = readOr(join(root, path));
    const here: LineageLock | null = hereText ? parseLock(hereText.toString("utf-8")) : null;
    const next: LineageLock = here ? JSON.parse(JSON.stringify(here)) : { lockVersion: 1, scopes: {} };
    let changed = false;
    const recorded = manifest.locks[path] ?? {};
    for (const scope of [...new Set([...Object.keys(recorded), ...Object.keys(there?.scopes ?? {})])].sort()) {
      const base = recorded[scope];
      const theirs = there?.scopes[scope];
      const ours = here?.scopes[scope];
      const theirDigest = copyDigests.get(`${path}#${scope}`);
      const changedThere = theirDigest === undefined ? base !== undefined : base === undefined || theirDigest !== base.export;
      if (!changedThere) continue;
      const changedHere = ours === undefined ? base !== undefined : base === undefined || lineageDigest(ours) !== base.host;
      const where = `${path} scope ${scope}`;
      if (changedHere) {
        conflicts.push({ path: where, reason: "the copy and this workspace both changed the lineage since the export" });
        continue;
      }
      if (!theirs) {
        delete next.scopes[scope];
        changed = true;
        continue;
      }
      if (base?.partial && ours) {
        // Only part of the scope went: take the copy's files, and nothing that would move the rest.
        const { files: _f, manualSteps: _m, repinned: _r, ...a } = ours;
        const { files: _f2, manualSteps: _m2, repinned: _r2, ...b } = theirs;
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          conflicts.push({ path: where, reason: "the copy upgraded a scope only part of which went with the export; upgrade it here instead" });
          continue;
        }
        const dir = lockDir(path);
        const went = (f: string) => manifest.files[scopedPath(dir, scope, f)] !== undefined || theirs.files[f] !== undefined;
        const files = Object.fromEntries(Object.entries(ours.files).filter(([f]) => !went(f)));
        next.scopes[scope] = {
          ...ours,
          files: { ...files, ...theirs.files },
          manualSteps: [...ours.manualSteps.filter((s) => !went(s.path)), ...theirs.manualSteps],
        };
      } else {
        next.scopes[scope] = theirs;
      }
      changed = true;
    }
    if (changed) lockWrites.set(path, next);
  }

  const result: ImportResult = {
    export: manifest.id,
    from: fromDir,
    written: [...writes.keys()],
    removed: removes,
    locks: [...lockWrites.keys()],
    hostValues: [...hostValues].filter((p) => writes.has(p)).sort(),
    conflicts,
    outside,
    returnRecord: null,
    return: null,
    member: null,
    applied: false,
  };
  if (outside.length > 0 || conflicts.length > 0) return result;
  const nothing = writes.size === 0 && removes.length === 0 && lockWrites.size === 0;

  // The return record: what came back, and where each file was made.
  const ownRepo = gitTopOf(fromDir);
  const own = ownRepo !== undefined && realpathSync(ownRepo) === realpathSync(fromDir);
  let head: string | null = null;
  if (own) {
    try {
      head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fromDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      head = null;
    }
  }
  const paths: ReturnRecord["paths"] = {};
  for (const [path, data] of writes) {
    const origin = own && head && !hostValues.has(path) ? buildOrigin(fromDir, path, data) : undefined;
    paths[path] = { sha256: fileHash(data), ...(origin ? { origin } : {}) };
  }
  for (const path of lockWrites.keys()) paths[path] = { sha256: fileHash(renderLock(lockWrites.get(path)!)) };
  const origins = Object.values(paths).flatMap((p) => (p.origin ? [p.origin] : []));
  const idBody = JSON.stringify({ export: manifest.id, head, paths: Object.fromEntries(Object.entries(paths).map(([p, v]) => [p, v.sha256])), removes });
  const ret: ReturnRecord = {
    schema: 1,
    id: `ret-${createHash("sha256").update(idBody).digest("hex").slice(0, 12)}`,
    export: { id: manifest.id, workspace: manifest.from.workspace, revision: manifest.from.revision },
    head,
    paths,
    removed: removes,
    hostValues: result.hostValues,
    signers: originSigners(origins),
  };
  if (!nothing) result.return = ret;
  if (o.dryRun) return result;

  // Apply.
  for (const [path, data] of writes) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
  }
  for (const path of removes) rmSync(join(root, path), { force: true });
  for (const [path, lock] of lockWrites) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, renderLock(lock));
  }
  if (!nothing) result.returnRecord = writeReturn(root, ret);
  result.applied = true;

  // The export member: written again from the workspace as it stands, or removed.
  result.member = await settleExportMember(root, decl, manifest, o.remove === true, fromDir);
  return result;
}

async function settleExportMember(root: string, decl: Declaration, manifest: ExportManifest, remove: boolean, fromDir: string): Promise<ImportResult["member"]> {
  const m = decl.members.find((x) => x.name === manifest.member);
  if (!m) return null;
  if (!remove) {
    const again: ExportResult = await exportWorkspace({
      root,
      to: m.name,
      ...(manifest.whole ? {} : { members: manifest.members }),
      params: Object.fromEntries(Object.values(manifest.hostValues).flatMap((v) => Object.entries(v).map(([n, x]) => [n, x.export]))),
    });
    return { name: m.name, action: "regenerated", note: `${again.manifest.id}, ${again.files} file(s)` };
  }
  rmSync(join(root, m.dir), { recursive: true, force: true });
  const { file, obj } = rawDeclaration(root);
  if (file.endsWith(".jsonc")) {
    return { name: m.name, action: "removed", note: `removed ${m.dir}; ${file} keeps comments, so drop the entry for ${m.name} by hand` };
  }
  obj.members = (obj.members as { name: string }[]).filter((e) => e.name !== m.name);
  writeFileSync(join(root, file), JSON.stringify(obj, null, 2) + "\n");
  const inside = resolve(fromDir) === resolve(root, m.dir);
  return { name: m.name, action: "removed", note: `removed ${m.dir} and its entry in ${file}${inside ? "" : `; the copy at ${relative(root, fromDir) || "."} is left as it is`}` };
}
