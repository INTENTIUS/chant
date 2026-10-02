/**
 * `chant workspace export`: write members of this workspace, with their
 * lineage and records, into the workspace's export member as a workspace of
 * their own (#2552, #2524 D10, requirements X1 to X3 and X6, ws-073).
 *
 * The export goes into its own member, found by role: a member of kind
 * `workspace` with the role `export`. Nothing is written anywhere else, and a
 * layout where the export would land inside another member, or another
 * member inside the export, is refused. That member is a nested workspace
 * (ws-071): the outer workspace reads it only through its own commands, and
 * export is the one command that writes there.
 *
 * Only members that declare `travel: true` go (X6). With no members named,
 * every such member goes, with the workspace's own record kinds and their
 * records: that is an export of the workspace. Naming members exports just
 * those, each with the record kinds it declares.
 *
 * The export keeps the workspace's layout: a member at `app/` is at
 * `<export>/app/`. It gets a declaration listing the members that went, each
 * entry copied as written, less the links, agents and pins that point at
 * members that stayed. The lineage of each scope goes with it, filtered to
 * the files that went. Records are copied byte for byte, so every seal on
 * them stays as it was.
 *
 * Host-bound parameters (D9) switch on export (X3): `--param name=value`
 * gives an exported lineage's host-bound parameter the value it has where the
 * export goes. The files the lineage lists for it get the new value, the lock
 * records it, and a file that had its recorded hash keeps a matching one. The
 * host's values stay in `.chant/export.json`, where `import` reads them to
 * switch back.
 *
 * `.chant/export.json` records where the export came from (the workspace's
 * name and revision, ws-016), what went, and the hash each file had here and
 * in the export. Import uses those as its merge base.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { z } from "zod";
import { DECLARATION_FILES, readDeclaration, type Declaration, type Member } from "./declaration";
import { parseJsonText } from "./jsonc";
import { fileHash, LOCK_FILE, LockError, parseLock, renderLock, type Lineage, type LineageLock } from "./lineage-lock";
import { loadRecordKind } from "./records";
import { workingTree } from "./tree";

/** The role that marks the member an export is written into. */
export const EXPORT_ROLE = "export";

/** The export manifest, relative to the export's root. */
export const EXPORT_MANIFEST = ".chant/export.json";

const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const ManifestSchema = z
  .object({
    schema: z.literal(1),
    /** `exp-<12 hex>`, from what the export holds. */
    id: z.string().regex(/^exp-[0-9a-f]{12}$/),
    from: z
      .object({
        /** The declaration's `name`. */
        workspace: z.string().min(1),
        /** HEAD of the repository when the export was written, or null outside git. */
        revision: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).nullable(),
        /** Whether exported paths had uncommitted changes. */
        dirty: z.boolean(),
      })
      .strict(),
    /** The export member's name. */
    member: z.string().min(1),
    /** The members that went, by name. */
    members: z.array(z.string().min(1)),
    /** True when no members were named: the workspace's own record kinds went too. */
    whole: z.boolean(),
    /** Directories, relative to the workspace root, that went besides member directories: the workspace's own record kinds and records. */
    dirs: z.array(z.string().min(1)),
    /** Every exported file, relative to the workspace root, with its hash here and in the export. Locks are under `locks`. */
    files: z.record(z.string(), z.object({ host: Sha256, export: Sha256 }).strict()),
    /** Each lock that went, by its path relative to the workspace root, with each scope's digest here and in the export, and whether only part of it went. */
    locks: z.record(z.string(), z.record(z.string(), z.object({ host: Sha256, export: Sha256, partial: z.boolean() }).strict())),
    /** Host-bound values switched, by `<lock path>#<scope>`, then parameter: the value here and in the export. */
    hostValues: z.record(z.string(), z.record(z.string(), z.object({ host: z.string(), export: z.string() }).strict())),
    /** What the export's declaration leaves out, because it names members that stayed. */
    dropped: z
      .object({
        links: z.array(z.object({ member: z.string(), to: z.string() }).strict()),
        agents: z.array(z.string()),
        pins: z.array(z.string()),
        records: z.array(z.string()),
        diagrams: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type ExportManifest = z.infer<typeof ManifestSchema>;

export class ExportError extends LockError {
  override name = "ExportError";
}

// ── Reading ──────────────────────────────────────────────────────────────────

export function parseManifest(text: string, label: string): ExportManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ExportError(`${label} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) throw new ExportError(`${label} is not an export manifest: ${parsed.error.issues.map((i) => `${i.path.join(".") || "/"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export function readManifestAt(dir: string): ExportManifest | null {
  const abs = join(dir, EXPORT_MANIFEST);
  if (!existsSync(abs)) return null;
  return parseManifest(readFileSync(abs, "utf-8"), abs);
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** `true` when `path` is `dir` or below it. Both relative, `/`-separated, `"."` for the root. */
export function under(path: string, dir: string): boolean {
  return dir === "." || path === dir || path.startsWith(`${dir}/`);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

export function gitTopOf(dir: string): string | undefined {
  try {
    return git(dir, ["rev-parse", "--show-toplevel"]).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The files under `dir` (absolute) that git tracks or would track, relative
 * to `dir`, that exist in the working tree. Outside git, every file, leaving
 * out `.git` and `node_modules`.
 */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const top = gitTopOf(dir);
  if (top) {
    const out = git(dir, ["ls-files", "-z", "-co", "--exclude-standard", "--full-name", "--", "."]);
    // git reports its top with symlinks resolved (/var is /private/var on macOS).
    const prefix = relative(top, realpathSync(dir)).split("\\").join("/");
    return [...new Set(out.split("\0").filter(Boolean))]
      .map((p) => (prefix ? p.slice(prefix.length + 1) : p))
      .filter((p) => {
        try {
          return statSync(join(dir, p)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  }
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (d.name === ".git" || d.name === "node_modules") continue;
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(p);
      else if (d.isFile()) out.push(p);
    }
  };
  walk("");
  return out.sort();
}

/** A lock's path, relative to the workspace root, is a lock file: `.chant/workspace.lock.json` at some directory. */
export function isLockPath(path: string): boolean {
  return path === LOCK_FILE || path.endsWith(`/${LOCK_FILE}`);
}

/** The directory, relative to the workspace root, a lock at `path` sits in. */
export function lockDir(path: string): string {
  return path === LOCK_FILE ? "." : path.slice(0, -(LOCK_FILE.length + 1));
}

/** Join a lock directory, a scope and a file into a workspace-relative path. */
export function scopedPath(dir: string, scope: string, file: string): string {
  return [dir, scope, file].filter((p) => p !== "." && p !== "").join("/");
}

/** The digest of a lineage, for telling whether it changed. */
export function lineageDigest(lineage: Lineage): string {
  const lock: LineageLock = { lockVersion: 1, scopes: { s: lineage } };
  return fileHash(renderLock(lock));
}

/**
 * Switch host-bound values in a scope (#2552): for each parameter in
 * `values`, the files the lineage lists for it get `to` in place of `from`,
 * the lineage records `to`, and a file that had its recorded hash keeps a
 * matching one. `files` holds the scope's files by workspace-relative path,
 * and is changed in place. Returns the paths whose content changed.
 */
export function switchHostValues(
  lineage: Lineage,
  dir: string,
  scope: string,
  values: Record<string, { from: string; to: string }>,
  files: Map<string, Buffer>,
): string[] {
  const changed: string[] = [];
  for (const [name, { from, to }] of Object.entries(values)) {
    if (from === to) continue;
    for (const f of lineage.hostBound?.[name] ?? []) {
      const path = scopedPath(dir, scope, f);
      const before = files.get(path);
      if (!before) continue;
      const after = Buffer.from(before.toString("utf-8").split(from).join(to), "utf-8");
      if (after.equals(before)) continue;
      files.set(path, after);
      changed.push(path);
      const entry = lineage.files[f];
      if (entry && entry.sha256 === fileHash(before)) lineage.files[f] = { ...entry, sha256: fileHash(after) };
    }
    lineage.parameters = { ...lineage.parameters, [name]: to };
  }
  return [...new Set(changed)].sort();
}

/** The raw declaration object, read as JSON or JSONC. */
export function rawDeclaration(root: string): { file: string; obj: Record<string, unknown> } {
  for (const name of DECLARATION_FILES) {
    const abs = join(root, name);
    if (!existsSync(abs)) continue;
    const parsed = parseJsonText(readFileSync(abs, "utf-8"), { jsonc: name.endsWith(".jsonc") });
    if (!parsed.ok) throw new ExportError(`${name} can't be read: ${parsed.message}`);
    return { file: name, obj: parsed.value as Record<string, unknown> };
  }
  throw new ExportError(`no chant.workspace.json at ${root}`);
}

/** The export member: the one with the export role, or the one `to` names. */
export function exportMember(decl: Declaration, to?: string): Member {
  const withRole = decl.members.filter((m) => m.roles.some((r) => r.name === EXPORT_ROLE));
  let m: Member | undefined;
  if (to !== undefined) {
    m = decl.members.find((x) => x.name === to);
    if (!m) throw new ExportError(`--to ${to}: the declaration has no member ${to}`);
    if (!withRole.includes(m)) throw new ExportError(`--to ${to}: member ${to} does not have the role ${EXPORT_ROLE}; an export goes only into a member with that role`);
  } else if (withRole.length === 1) {
    m = withRole[0];
  } else if (withRole.length === 0) {
    throw new ExportError(`no member has the role ${EXPORT_ROLE}; declare one, of kind workspace, for the export to go into`);
  } else {
    throw new ExportError(`${withRole.length} members have the role ${EXPORT_ROLE} (${withRole.map((x) => x.name).join(", ")}); name one with --to <member>`);
  }
  if (m.kind !== "workspace") throw new ExportError(`member ${m.name} has kind ${m.kind}; an export is a workspace, so its member has kind workspace`);
  if (m.dir === ".") throw new ExportError(`member ${m.name} is the workspace root; an export needs a directory of its own`);
  return m;
}

// ── Export ───────────────────────────────────────────────────────────────────

export interface ExportOptions {
  /** The workspace root, where `chant.workspace.json` is. */
  root: string;
  /** Members to export. Empty or absent: every member that travels, with the workspace's own records. */
  members?: string[];
  /** The export member's name, when more than one has the role. */
  to?: string;
  /** Host-bound parameter values for the export. */
  params?: Record<string, string>;
  dryRun?: boolean;
}

export interface ExportResult {
  member: string;
  /** The export's directory, relative to the workspace root. */
  dir: string;
  manifest: ExportManifest;
  /** Files written, relative to the export's root, besides the declaration and the manifest. */
  files: number;
  /** Paths, relative to the workspace root, whose host-bound values were switched. */
  switched: string[];
  written: boolean;
}

/** Plan the export, and write it unless `dryRun`. Throws an {@link ExportError}. */
export async function exportWorkspace(o: ExportOptions): Promise<ExportResult> {
  const root = resolve(o.root);
  const decl = readDeclaration(workingTree(root));
  const target = exportMember(decl, o.to);
  const whole = !o.members || o.members.length === 0;

  // What goes.
  let members: Member[];
  if (whole) {
    members = decl.members.filter((m) => m.travel && m !== target);
    if (members.length === 0) throw new ExportError(`no member sets travel to true, so nothing goes with an export; set it on each member that should`);
  } else {
    members = [];
    for (const name of new Set(o.members)) {
      const m = decl.members.find((x) => x.name === name);
      if (!m) throw new ExportError(`the declaration has no member ${name}`);
      if (m === target) throw new ExportError(`member ${name} is the export member itself`);
      if (!m.travel) throw new ExportError(`member ${name} does not set travel to true, so it stays with the workspace`);
      members.push(m);
    }
  }
  if (members.some((m) => m.dir === ".")) throw new ExportError(`member ${members.find((m) => m.dir === ".")!.name} is the workspace root, and the root can't travel as a member`);

  // Never into another member, never another member inside the export (D10).
  for (const m of decl.members) {
    if (m === target) continue;
    if (m.dir !== "." && under(target.dir, m.dir)) throw new ExportError(`the export member ${target.name} (${target.dir}) is inside member ${m.name} (${m.dir}); an export never writes into another member`);
    if (under(m.dir, target.dir)) throw new ExportError(`member ${m.name} (${m.dir}) is inside the export member ${target.name} (${target.dir}); an export would write over it`);
  }

  // The workspace's own record kinds, for a whole export.
  const dirs: string[] = [];
  const dropped: ExportManifest["dropped"] = { links: [], agents: [], pins: [], records: [], diagrams: [] };
  if (whole) {
    for (const k of decl.records) {
      const loaded = await loadRecordKind(join(root, k.path), root);
      for (const d of [posix.dirname(k.path), relative(root, loaded.dir).split("\\").join("/") || "."]) {
        if (d === "." || d.startsWith("..")) throw new ExportError(`record kind ${k.kind} keeps its kind file or records at the workspace root; an export takes directories, so move them into one`);
        if (!dirs.includes(d)) dirs.push(d);
      }
    }
  } else {
    dropped.records = decl.records.map((k) => k.kind);
  }
  for (const d of dirs) {
    if (under(d, target.dir) || under(target.dir, d)) throw new ExportError(`the record directory ${d} overlaps the export member ${target.name}`);
  }

  // The files, read once. Another member's directory inside one that goes is left out.
  const others = decl.members.filter((m) => !members.includes(m));
  const files = new Map<string, Buffer>();
  const locks = new Map<string, LineageLock>();
  for (const d of [...members.map((m) => m.dir), ...dirs]) {
    for (const f of listFiles(join(root, d))) {
      const path = `${d}/${f}`;
      if (others.some((m) => m.dir !== "." && under(path, m.dir))) continue;
      if (isLockPath(path)) {
        locks.set(path, parseLock(readFileSync(join(root, path), "utf-8")));
        continue;
      }
      files.set(path, readFileSync(join(root, path)));
    }
  }
  const hostFiles = new Map(files);

  // The root lock goes, filtered to the files that went.
  if (existsSync(join(root, LOCK_FILE))) locks.set(LOCK_FILE, parseLock(readFileSync(join(root, LOCK_FILE), "utf-8")));
  const exportLocks = new Map<string, LineageLock>();
  const lockDigests: ExportManifest["locks"] = {};
  const hostValues: ExportManifest["hostValues"] = {};
  const switched = new Set<string>();
  const params = { ...(o.params ?? {}) };
  const usedParams = new Set<string>();
  for (const [path, lock] of locks) {
    const dir = lockDir(path);
    const out: LineageLock = { lockVersion: lock.lockVersion, scopes: {} };
    for (const [scope, lineage] of Object.entries(lock.scopes)) {
      const all = Object.keys(lineage.files);
      const kept = all.filter((f) => files.has(scopedPath(dir, scope, f)) || (lineage.files[f].class === "generated" && members.some((m) => under(scopedPath(dir, scope, f), m.dir))));
      const scopeDir = scopedPath(dir, scope, "") || ".";
      const inside = members.some((m) => under(scopeDir, m.dir)) || dirs.some((d) => under(scopeDir, d));
      if (kept.length === 0 && !inside) continue;
      const copy: Lineage = JSON.parse(JSON.stringify(lineage));
      copy.files = Object.fromEntries(kept.map((f) => [f, lineage.files[f]]));
      copy.manualSteps = lineage.manualSteps.filter((s) => kept.includes(s.path));
      if (copy.repinned) copy.repinned = copy.repinned.filter((r) => kept.includes(r.record));
      // Host-bound values switch (X3).
      const values: Record<string, { from: string; to: string }> = {};
      for (const name of Object.keys(lineage.hostBound ?? {})) {
        if (params[name] === undefined) continue;
        usedParams.add(name);
        const from = lineage.parameters[name];
        if (typeof from !== "string") throw new ExportError(`${path} scope ${scope}: host-bound parameter ${name} has no recorded value to switch`);
        const pinned = (lineage.repinned ?? []).filter((r) => r.paths.some((p) => (lineage.hostBound![name] ?? []).includes(p)));
        if (pinned.length > 0) throw new ExportError(`${path} scope ${scope}: ${pinned[0].record} pins a file that carries host-bound ${name}; switching it would break the pin and the record's seal`);
        values[name] = { from, to: params[name] };
      }
      if (Object.keys(values).length > 0) {
        for (const p of switchHostValues(copy, dir, scope, values, files)) switched.add(p);
        hostValues[`${path}#${scope}`] = Object.fromEntries(Object.entries(values).map(([n, v]) => [n, { host: v.from, export: v.to }]));
      }
      out.scopes[scope] = copy;
      lockDigests[path] = { ...(lockDigests[path] ?? {}), [scope]: { host: lineageDigest(lineage), export: lineageDigest(copy), partial: kept.length < all.length } };
    }
    if (Object.keys(out.scopes).length > 0) exportLocks.set(path, out);
  }
  const unused = Object.keys(params).filter((p) => !usedParams.has(p)).sort();
  if (unused.length > 0) throw new ExportError(`--param ${unused.join(", ")}: no exported lineage has a host-bound parameter by that name`);

  // The export's declaration: the members that went, as written.
  const raw = rawDeclaration(root).obj;
  const names = new Set(members.map((m) => m.name));
  const outDecl: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "members") {
      outDecl.members = (value as Record<string, unknown>[])
        .filter((e) => typeof e.name === "string" && names.has(e.name))
        .map((e) => {
          const links = e.links as { member: string }[] | undefined;
          if (!links) return e;
          const keep = links.filter((l) => names.has(l.member));
          for (const l of links) if (!names.has(l.member)) dropped.links.push({ member: e.name as string, to: l.member });
          const { links: _links, ...rest } = e;
          return keep.length > 0 ? { ...rest, links: keep } : rest;
        });
    } else if (key === "agents") {
      const agents = value as { name: string; member: string }[];
      for (const a of agents) if (!names.has(a.member)) dropped.agents.push(a.name);
      outDecl.agents = agents.filter((a) => names.has(a.member));
    } else if (key === "pins") {
      const pins = value as { path?: string; package?: string }[];
      for (const p of pins) if (p.path !== undefined) dropped.pins.push(p.path);
      outDecl.pins = pins.filter((p) => p.path === undefined);
    } else if (key === "records") {
      if (whole) outDecl.records = value;
    } else if (key === "diagrams") {
      for (const d of value as { name: string }[]) dropped.diagrams.push(d.name);
    } else {
      outDecl[key] = value;
    }
  }

  // The manifest.
  const fileHashes: ExportManifest["files"] = {};
  for (const path of [...files.keys()].sort()) fileHashes[path] = { host: fileHash(hostFiles.get(path)!), export: fileHash(files.get(path)!) };
  const top = gitTopOf(root);
  let revision: string | null = null;
  let dirty = false;
  if (top) {
    try {
      revision = git(root, ["rev-parse", "HEAD"]).trim();
    } catch {
      revision = null;
    }
    const exported = [...members.map((m) => m.dir), ...dirs];
    dirty = git(root, ["status", "--porcelain", "--", ...exported]).trim() !== "";
  }
  const body = {
    from: { workspace: decl.name, revision, dirty },
    member: target.name,
    members: members.map((m) => m.name),
    whole,
    dirs: [...dirs].sort(),
    files: fileHashes,
    locks: lockDigests,
    hostValues,
    dropped,
  };
  const id = `exp-${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 12)}`;
  const manifest = ManifestSchema.parse({ schema: 1, id, ...body });

  const result: ExportResult = { member: target.name, dir: target.dir, manifest, files: files.size + exportLocks.size, switched: [...switched].sort(), written: false };
  if (o.dryRun) return result;

  // Write: the export member only, after clearing what an earlier export left.
  const out = join(root, target.dir);
  if (existsSync(out)) {
    const present = readdirSync(out);
    if (present.length > 0 && !existsSync(join(out, EXPORT_MANIFEST))) {
      throw new ExportError(`${target.dir} holds files no export wrote (it has no ${EXPORT_MANIFEST}); export writes only into an empty export member or over an earlier export`);
    }
    for (const name of present) if (name !== ".git") rmSync(join(out, name), { recursive: true, force: true });
  }
  const put = (rel: string, data: Buffer | string) => {
    const abs = resolve(out, rel);
    if (relative(out, abs).startsWith("..")) throw new ExportError(`${rel} would land outside the export member`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
  };
  for (const [path, data] of files) put(path, data);
  for (const [path, lock] of exportLocks) put(path, renderLock(lock));
  put("chant.workspace.json", JSON.stringify(outDecl, null, 2) + "\n");
  put(EXPORT_MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  result.written = true;
  return result;
}
