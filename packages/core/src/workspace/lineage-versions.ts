/**
 * `chant workspace versions [<dir>] [--template <id>] [--json]` (#2551, D9,
 * requirement T9).
 *
 * Reports, for a family of workspaces, which template version and which chant
 * and lexicon versions each one is on. A family is the set of workspaces made
 * from the same template: each lineage scope belongs to the family of its
 * template id. The command finds every `.chant/workspace.lock.json` under
 * `<dir>` (the working directory by default), so pointing it at a directory of
 * checkouts compares them all. Nothing is fetched and no code runs: it reads
 * lock files and `package.json` files only.
 *
 * Per D9 the word "drift" keeps its existing meanings, so a workspace on an
 * older version than the newest one in its family is reported as `behind`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { LOCK_FILE, LockError, lineageProvenance, readLock } from "./lineage-lock";
import { compareVersions, formatVersion, parseVersion } from "./lineage-version";

/** How deep under `<dir>` a lock is looked for. */
export const MAX_DEPTH = 8;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".chant"]);

export interface ScopeVersion {
  scope: string;
  kind: "template" | "vendor";
  template: string;
  ref: string | null;
  /** The version the ref names, or null when it names none (a branch, a commit). */
  version: string | null;
  commit: string | null;
  migrations: number;
  provenance: "adopted" | "unattested";
}

export interface PluginVersion {
  name: string;
  /** The range `package.json` declares. */
  declared: string;
  /** The version installed where the workspace resolves it, or null when it is not installed. */
  installed: string | null;
}

export interface WorkspaceVersions {
  /** Relative to `<dir>`, `.` for `<dir>` itself. */
  path: string;
  scopes: ScopeVersion[];
  plugins: PluginVersion[];
  /** Set when the lock could not be read; the workspace then has no scopes. */
  error?: string;
}

export interface FamilyMember {
  path: string;
  scope: string;
  ref: string | null;
  version: string | null;
  /** Older than the newest version in the family. */
  behind: boolean;
}

export interface Family {
  template: string;
  /** The newest version any member is on, or null when no member's ref is a version. */
  newest: string | null;
  members: FamilyMember[];
}

export interface VersionsReport {
  root: string;
  workspaces: WorkspaceVersions[];
  families: Family[];
  /** chant and lexicon packages that members of one family have at different installed versions. */
  pluginSpread: Array<{ template: string; name: string; versions: Record<string, string[]> }>;
}

/** Every directory under `dir` that holds a lineage lock, nearest first. */
export function findLocks(dir: string, depth = MAX_DEPTH): string[] {
  const found: string[] = [];
  const walk = (at: string, level: number): void => {
    if (existsSync(join(at, LOCK_FILE))) found.push(at);
    if (level >= depth) return;
    let names: string[];
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (SKIP_DIRS.has(name) || (name.startsWith(".") && name !== ".")) continue;
      const child = join(at, name);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(child, level + 1);
    }
  };
  walk(dir, 0);
  return found;
}

function isPlugin(name: string): boolean {
  return name === "@intentius/chant" || name.startsWith("@intentius/chant-lexicon-");
}

/** The version of `pkg` that node would resolve from `dir`: the nearest `node_modules/<pkg>` going up. */
function installedVersion(pkg: string, dir: string): string | null {
  let at = dir;
  for (;;) {
    const manifest = join(at, "node_modules", pkg, "package.json");
    if (existsSync(manifest)) {
      try {
        return (JSON.parse(readFileSync(manifest, "utf-8")) as { version?: string }).version ?? null;
      } catch {
        return null;
      }
    }
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** chant and its lexicons, as the workspace's `package.json` declares them. */
export function pluginVersions(dir: string): PluginVersion[] {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return [];
  let json: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    json = JSON.parse(readFileSync(manifest, "utf-8"));
  } catch {
    return [];
  }
  const declared = { ...(json.devDependencies ?? {}), ...(json.dependencies ?? {}) };
  return Object.keys(declared)
    .filter(isPlugin)
    .sort()
    .map((name) => ({ name, declared: declared[name], installed: installedVersion(name, dir) }));
}

/** Build the report for every workspace under `dir`, narrowed to one template's family when `template` is given. */
export function workspaceVersions(dir: string, template?: string): VersionsReport {
  const root = resolve(dir);
  const workspaces: WorkspaceVersions[] = [];
  for (const at of findLocks(root)) {
    const path = relative(root, at).split(sep).join("/") || ".";
    let scopes: ScopeVersion[] = [];
    let error: string | undefined;
    try {
      const lock = readLock(at)!;
      scopes = Object.entries(lock.scopes).map(([scope, l]) => {
        const v = parseVersion(l.ref);
        return {
          scope,
          kind: l.kind,
          template: l.template,
          ref: l.ref ?? null,
          version: v ? formatVersion(v) : null,
          commit: l.address?.commit ?? null,
          migrations: l.migrations.length,
          provenance: lineageProvenance(l),
        };
      });
    } catch (err) {
      if (!(err instanceof LockError)) throw err;
      error = err.message;
    }
    if (template !== undefined && !error && !scopes.some((s) => s.template === template)) continue;
    workspaces.push({ path, scopes, plugins: pluginVersions(at), ...(error ? { error } : {}) });
  }

  const byTemplate = new Map<string, FamilyMember[]>();
  for (const w of workspaces) {
    for (const s of w.scopes) {
      if (template !== undefined && s.template !== template) continue;
      const list = byTemplate.get(s.template) ?? [];
      list.push({ path: w.path, scope: s.scope, ref: s.ref, version: s.version, behind: false });
      byTemplate.set(s.template, list);
    }
  }
  const families: Family[] = [];
  const pluginSpread: VersionsReport["pluginSpread"] = [];
  for (const [id, members] of [...byTemplate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const versions = members.map((m) => (m.version ? parseVersion(m.version)! : null)).filter((v) => v !== null);
    const newest = versions.length > 0 ? versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b)) : null;
    for (const m of members) {
      m.behind = newest !== null && m.version !== null && compareVersions(parseVersion(m.version)!, newest) < 0;
    }
    families.push({ template: id, newest: newest ? formatVersion(newest) : null, members });

    const paths = new Set(members.map((m) => m.path));
    const seen = new Map<string, Record<string, string[]>>();
    for (const w of workspaces.filter((w) => paths.has(w.path))) {
      for (const p of w.plugins) {
        const v = p.installed ?? `not installed (${p.declared})`;
        const entry = seen.get(p.name) ?? {};
        (entry[v] ??= []).push(w.path);
        seen.set(p.name, entry);
      }
    }
    for (const [name, spread] of [...seen.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (Object.keys(spread).length > 1) pluginSpread.push({ template: id, name, versions: spread });
    }
  }
  return { root, workspaces, families, pluginSpread };
}

/** The report as terminal lines. */
export function describeVersions(report: VersionsReport): string[] {
  const lines: string[] = [];
  for (const w of report.workspaces) {
    lines.push(w.path);
    if (w.error) lines.push(`  unreadable: ${w.error}`);
    for (const s of w.scopes) {
      const at = s.commit ? ` (${s.commit.slice(0, 12)})` : "";
      lines.push(`  ${s.scope}  ${s.template}@${s.ref ?? "(no ref)"}${at}  ${s.provenance}${s.migrations > 0 ? `, ${s.migrations} migration(s)` : ""}`);
    }
    if (w.plugins.length > 0) {
      lines.push(`  plugins: ${w.plugins.map((p) => `${p.name} ${p.installed ?? `not installed (${p.declared})`}`).join(", ")}`);
    }
  }
  for (const f of report.families) {
    const behind = f.members.filter((m) => m.behind);
    lines.push(
      `family ${f.template}: ${f.members.length} scope(s), newest ${f.newest ?? "(no versions)"}${behind.length > 0 ? `; behind: ${behind.map((m) => `${m.path}${m.scope === "." ? "" : `/${m.scope}`} (${m.ref})`).join(", ")}` : ""}`,
    );
    for (const s of report.pluginSpread.filter((p) => p.template === f.template)) {
      lines.push(`  ${s.name} differs: ${Object.entries(s.versions).map(([v, paths]) => `${v} in ${paths.join(", ")}`).join("; ")}`);
    }
  }
  if (report.workspaces.length === 0) lines.push(`no ${LOCK_FILE} under ${report.root}`);
  return lines;
}

export async function runWorkspaceVersions(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.extraPositional2) {
    console.error(formatError({ message: `unexpected argument: ${args.extraPositional2}`, hint: "chant workspace versions [<dir>] [--template <id>] [--json]" }));
    return 1;
  }
  const dir = resolve(args.extraPositional ?? ".");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(formatError({ message: `${dir} is not a directory` }));
    return 1;
  }
  const report = workspaceVersions(dir, args.template);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(describeVersions(report).join("\n"));
  return 0;
}
