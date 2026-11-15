/**
 * `chant workspace graph <dir> --discover` (#5095): the graph of a directory
 * that has no `chant.workspace.json`, read as if a declaration listed what
 * the kinds' probes find there. Nothing is written inside the directory.
 *
 * The walk visits every directory under `<dir>`, leaving out `node_modules`
 * and directories whose names start with a dot (`.git` among them), and
 * resolves each with {@link resolveKind}, by probe and precedence. What it
 * finds becomes a declaration held in memory, which {@link discoveredTree}
 * lays over the files as `chant.workspace.json` at the root. The read then
 * goes through the same path as a declared one: the same plan, reader
 * projects, member cache and composition.
 *
 * A claimed directory is a member unless one of these holds, and each case is
 * listed in `discovered` with its outcome:
 *
 * - `tie`: two or more kinds share the highest precedence. It is not read.
 * - `module`: a `.tf` file under `<dir>` calls it through a local `source`
 *   (`./` or `../`) in a `module` block, so it is a module, read with the root
 *   that calls it.
 * - `inside-member`: it sits inside another member's directory. Members don't
 *   nest (#2524 D2), except inside the root member `.`.
 *
 * Kinds come from the built-in kinds and from the `@intentius` packages that
 * publish a `./workspace-kinds` file and are installed beside the running
 * chant ({@link discoveryKinds}). A `node_modules` inside `<dir>` supplies
 * none, so discovering a directory loads no package it carries.
 *
 * A member's name comes from its path relative to `<dir>`
 * ({@link discoveredMemberNames}), so it stays the same across revisions.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { CHANT_INSTALL, dataExportTarget } from "./class-data";
import { DECLARATION_FILES, isInside, WorkspaceReadError } from "./declaration";
import { createKindRegistry, KINDS_SUBPATH, readPackageKinds, resolveKind, type KindProbe, type KindRegistry, type MemberKind } from "./kinds";
import { gitTop, gitTree, joinPath, resolveCommit, skippedDir, workingTree, type WorkspaceTree } from "./tree";
import type { LocatedWorkspace } from "./which-chant";

/** What became of one claimed directory. */
export type DiscoveryOutcome = "member" | "tie" | "module" | "inside-member";

/** One directory a kind's probe claims: an entry of the graph document's `discovered` list. */
export interface DiscoveredEntry {
  /** Relative to `<dir>`, with `/` separators; `"."` for `<dir>` itself. */
  dir: string;
  /** The member's name when `outcome` is `member`, else null. */
  member: string | null;
  /** The kind the precedence order picks; null for a tie. */
  kind: string | null;
  /** Where that kind comes from: `builtin`, or the package that supplies it; null for a tie. */
  source: string | null;
  /** That kind's probe, as its kinds file states it; null for a tie. */
  probe: KindProbe | null;
  outcome: DiscoveryOutcome;
  /** Every kind whose probe claims the directory, highest precedence first. */
  claims: { kind: string; precedence: number; source: string }[];
  /** Why the directory is not a member, in one line; null for a member. */
  note: string | null;
}

/** A package beside the running chant that supplies member kinds. */
export interface KindPackage {
  package: string;
  version: string;
  dir: string;
}

/** The kinds a discovery reads with, and the packages they came from. */
export interface DiscoveryKinds {
  registry: KindRegistry;
  packages: KindPackage[];
  /** Why a package's kinds couldn't be used, one line each. */
  problems: string[];
}

/** Paths are kept with `/`, as a tree's are. */
const toPosix = (p: string) => p.split("\\").join("/");

/**
 * Every `@intentius` package that publishes `./workspace-kinds`, found the way
 * Node resolves a bare import from `from`: in `node_modules/@intentius` of
 * `from` and each directory above it, the nearest copy of a name winning.
 * Sorted by name.
 */
export function kindPackagesBeside(from: string = CHANT_INSTALL): KindPackage[] {
  const found = new Map<string, KindPackage>();
  for (let at = resolve(from); ; at = dirname(at)) {
    const scope = join(at, "node_modules", "@intentius");
    let names: string[] = [];
    try {
      names = readdirSync(scope);
    } catch {
      // No scope here.
    }
    for (const n of names.sort()) {
      const dir = join(scope, n);
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as Record<string, unknown>;
        if (typeof pkg.name !== "string" || typeof pkg.version !== "string" || found.has(pkg.name)) continue;
        if (typeof dataExportTarget(pkg, KINDS_SUBPATH) !== "string") continue;
        found.set(pkg.name, { package: pkg.name, version: pkg.version, dir });
      } catch {
        // Not a package, or not readable: it supplies nothing.
      }
    }
    if (dirname(at) === at) break;
  }
  return [...found.values()].sort((a, b) => (a.package < b.package ? -1 : 1));
}

/**
 * The registry a discovery reads with: the built-in kinds and every kind the
 * packages beside the running chant supply. A name two packages both supply
 * is left out, as `loadKindRegistry` leaves it out. Never throws.
 */
export function discoveryKinds(from: string = CHANT_INSTALL): DiscoveryKinds {
  const packages = kindPackagesBeside(from);
  const problems: string[] = [];
  const owner = new Map<string, string>();
  const clashing = new Set<string>();
  const extra: MemberKind[] = [];
  for (const p of packages) {
    const read = readPackageKinds(p.dir, p.package);
    problems.push(...read.problems);
    for (const k of read.kinds) {
      const first = owner.get(k.name);
      if (first) {
        clashing.add(k.name);
        problems.push(`kind ${k.name} is supplied by both ${first} and ${p.package}; a kind name has one source`);
        continue;
      }
      owner.set(k.name, p.package);
      extra.push(k);
    }
  }
  return { registry: createKindRegistry(extra.filter((k) => !clashing.has(k.name))), packages, problems };
}

/** Text with HCL comments removed and string contents kept, so a brace in a comment doesn't count. */
function withoutComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"' && text[i] !== "\n"; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      out += " ";
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * The local `source` of every `module` block in HCL `text`: the ones that
 * start with `./` or `../`, as written. A registry or git source is not
 * local. HCL is not parsed: a `module "<name>" {` opener is found, its body
 * runs to the matching brace, and `source = "<path>"` is read at the body's
 * own level.
 */
export function localModuleSources(text: string): string[] {
  const src = withoutComments(text);
  const out: string[] = [];
  const opener = /(^|\n)\s*module\s+"[^"\n]*"\s*\{/g;
  for (let m = opener.exec(src); m; m = opener.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    let body = "";
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (c === '"') {
        const start = i;
        for (i++; i < src.length && src[i] !== '"' && src[i] !== "\n"; i++) if (src[i] === "\\") i++;
        if (depth === 1) body += src.slice(start, i + 1);
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      if (depth === 1 && c !== "}") body += c;
    }
    const source = /(?:^|\n)\s*source\s*=\s*"([^"\n]*)"/.exec(body)?.[1];
    if (source && (source.startsWith("./") || source.startsWith("../"))) out.push(source);
    opener.lastIndex = i;
  }
  return out;
}

/** Lowercase letters, digits and hyphens, as a member name allows. */
function nameOf(dir: string): string {
  return (
    dir
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "member"
  );
}

const NAME_MAX = 40;

function hashed(dir: string, base: string, length = 6): string {
  const digest = createHash("sha256").update(dir).digest("hex").slice(0, length);
  return `${base.slice(0, NAME_MAX - length - 1).replace(/-+$/, "")}-${digest}`;
}

/**
 * A member name for each directory, from its path relative to `<dir>`. Every
 * run of characters a name can't hold, `/` among them, becomes one `-`, and
 * letters are lowercased: `infra/net` is `infra-net`. `.` is `root`. A name
 * longer than 40 characters, or one that two directories would share, keeps
 * its first characters and ends in `-` and six hex digits of the SHA-256 of
 * the path, so it still depends on the path alone.
 */
export function discoveredMemberNames(dirs: readonly string[]): Map<string, string> {
  const plain = new Map(dirs.map((d) => [d, d === "." ? "root" : nameOf(d)]));
  const count = new Map<string, number>();
  for (const n of plain.values()) count.set(n, (count.get(n) ?? 0) + 1);
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const d of dirs) {
    const n = plain.get(d)!;
    let name = n.length > NAME_MAX || count.get(n)! > 1 ? hashed(d, n) : n;
    // Two paths whose digests share a prefix: take more of the digest.
    for (let length = 7; taken.has(name) && length <= 16; length++) name = hashed(d, n, length);
    taken.add(name);
    out.set(d, name);
  }
  return out;
}

export interface Discovery {
  /** The declaration the read uses, as JSON text. */
  declaration: string;
  entries: DiscoveredEntry[];
}

const claimOf = (k: MemberKind) => ({ kind: k.name, precedence: k.precedence, source: k.source });

/** The parts of a probe its kinds file states, without what chant adds. */
function probeOf(k: MemberKind): KindProbe {
  return structuredClone(k.probe);
}

/**
 * Walk `tree` and work out the members a declaration for it would list, the
 * `discovered` entries, and the declaration itself. `name` is the workspace's
 * name. Reads the tree only.
 */
export function discover(tree: WorkspaceTree, kinds: DiscoveryKinds, name: string): Discovery {
  const claimed: { dir: string; claims: MemberKind[]; winner: MemberKind | undefined }[] = [];
  const modules = new Map<string, Set<string>>();
  const walk = (dir: string) => {
    const entries = tree.list(dir) ?? [];
    // The root's own declaration would make it a nested workspace of itself; a declared root never gets here, but --at may hold one below.
    const r = resolveKind(kinds.registry, tree, dir, dir === "" ? ["workspace"] : []);
    if (r.claims.length > 0) claimed.push({ dir, claims: r.claims, winner: r.winner });
    for (const e of entries) {
      if (e.type !== "file" || !e.name.endsWith(".tf")) continue;
      let text: string;
      try {
        text = tree.read(joinPath(dir, e.name));
      } catch {
        continue;
      }
      for (const source of localModuleSources(text)) {
        const target = posix.normalize(posix.join(dir || ".", source)).replace(/\/+$/, "");
        if (target === ".." || target.startsWith("../")) continue;
        const key = target === "." ? "" : target;
        if (key === dir) continue;
        const callers = modules.get(key) ?? new Set<string>();
        callers.add(dir || ".");
        modules.set(key, callers);
      }
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.type === "dir" && !skippedDir(e.name)) walk(joinPath(dir, e.name));
    }
  };
  walk("");
  claimed.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));

  const shown = (d: string) => d || ".";
  const entries: DiscoveredEntry[] = [];
  const memberDirs: string[] = [];
  for (const c of claimed) {
    const base = {
      dir: shown(c.dir),
      member: null,
      kind: c.winner?.name ?? null,
      source: c.winner?.source ?? null,
      probe: c.winner ? probeOf(c.winner) : null,
      claims: c.claims.map(claimOf),
    };
    const callers = modules.get(c.dir);
    if (callers) {
      entries.push({ ...base, outcome: "module", note: `called as a module through a local source by ${[...callers].sort().join(", ")}` });
      continue;
    }
    if (!c.winner) {
      const tied = c.claims.filter((k) => k.precedence === c.claims[0].precedence);
      entries.push({ ...base, outcome: "tie", note: `kinds ${tied.map((k) => k.name).join(" and ")} claim it at precedence ${tied[0].precedence}; name its kind in a declaration to read it` });
      continue;
    }
    const outer = memberDirs.find((m) => m !== "" && isInside(c.dir, m));
    if (outer !== undefined) {
      entries.push({ ...base, outcome: "inside-member", note: `inside member directory ${outer}; members don't nest, except inside the root member .` });
      continue;
    }
    memberDirs.push(c.dir);
    entries.push({ ...base, outcome: "member", note: null });
  }

  const names = discoveredMemberNames(memberDirs.map(shown));
  for (const e of entries) if (e.outcome === "member") e.member = names.get(e.dir)!;
  const members = entries.filter((e) => e.outcome === "member").map((e) => ({ name: e.member!, dir: e.dir, kind: e.kind! }));
  const used = new Set(entries.filter((e) => e.outcome === "member").map((e) => e.source));
  const pins = kinds.packages.filter((p) => used.has(p.package)).map((p) => ({ package: p.package, version: p.version }));
  const declaration = { name, schema: 1, ...(pins.length > 0 ? { pins } : {}), members };
  return { declaration: `${JSON.stringify(declaration, null, 2)}\n`, entries };
}

/** The file the in-memory declaration is shown as. */
export const DISCOVERED_DECLARATION = DECLARATION_FILES[0];

/**
 * `base` with the in-memory declaration shown as `chant.workspace.json` at
 * its root. Every other path reads through to `base`. Nothing is written.
 */
export function discoveredTree(base: WorkspaceTree, declaration: string): WorkspaceTree {
  const file = DISCOVERED_DECLARATION;
  return {
    label: base.label,
    stat: (path) => (path === file ? "file" : base.stat(path)),
    list: (path) => {
      const entries = base.list(path);
      if (path !== "" || !entries) return entries;
      return [...entries.filter((e) => e.name !== file), { name: file, type: "file" }];
    },
    read: (path) => (path === file ? declaration : base.read(path)),
    bytes: (path) => (path === file ? new TextEncoder().encode(declaration) : base.bytes ? base.bytes(path) : new TextEncoder().encode(base.read(path))),
  };
}

/** Whether `tree` holds a declaration at its root. */
export function declares(tree: WorkspaceTree): boolean {
  return DECLARATION_FILES.some((f) => tree.stat(f) === "file");
}

/** The workspace name a discovered read gives `dir`: its base name, made a valid name. */
export function discoveredWorkspaceName(dir: string): string {
  return nameOf(basename(dir)).slice(0, NAME_MAX).replace(/-+$/, "") || "workspace";
}

/**
 * The working tree under `root` without the symbolic links to directories, so
 * the walk stays inside `root` and can't go round a loop. A link to a file is
 * kept.
 */
function withoutDirLinks(tree: WorkspaceTree, root: string): WorkspaceTree {
  return {
    ...tree,
    list: (path) =>
      tree.list(path)?.filter((e) => {
        if (e.type !== "dir") return true;
        try {
          return !lstatSync(join(root, ...joinPath(path, e.name).split("/"))).isSymbolicLink();
        } catch {
          return false;
        }
      }),
  };
}

/**
 * Where a discovered read of `dir` reads: the working tree, or for `at` the
 * commit's tree under `dir`, before the declaration is laid over it. Throws
 * a {@link WorkspaceReadError}: for `at`, `not-a-git-repository` and
 * `revision-unknown`.
 */
export function locateDiscovered(dir: string, at?: string): Omit<LocatedWorkspace, "tree"> & { base: WorkspaceTree } {
  const rootOnDisk = resolve(dir);
  const top = gitTop(rootOnDisk);
  const rel = top ? toPosix(relative(top, realpathSync(rootOnDisk))) : undefined;
  const root = rel === undefined || rel.startsWith("..") ? rootOnDisk : rel === "" ? "." : rel;
  if (at === undefined) return { base: withoutDirLinks(workingTree(rootOnDisk), rootOnDisk), root, rootOnDisk, at: null, top };
  if (!top) throw new WorkspaceReadError("not-a-git-repository", "--at reads git objects, and this directory is not in a git repository");
  const commit = resolveCommit(top, at);
  if (!commit) throw new WorkspaceReadError("revision-unknown", `--at ${at} names no commit in this repository`);
  return { base: gitTree(top, commit, root === "." ? "" : root), root, rootOnDisk, at: commit, top };
}
