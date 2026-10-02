/**
 * `chant workspace init [dir] [--name <name>] [--yes] [--verbose]` (#2534):
 * propose a declaration from the projects already in a repository, print it
 * with the directories that would leave the root project, and write it only
 * once the user confirms (#2525 rule 1, ws-012).
 *
 * The proposal is a starting point for review, never written silently:
 *
 * - each outermost chant project (a chant.config.ts or .json) becomes a
 *   `chant` member, and the root's own config makes a root member `"."`;
 * - each nested declaration becomes a `workspace` member;
 * - each other npm package, from the npm workspaces or any other
 *   package.json, becomes an `other` member with a `because`;
 * - projects under an `examples`, `test` or `fixtures`-style directory become
 *   example groups (ws-051), one glob per tree where the tree is mostly
 *   projects, explicit paths where it isn't;
 * - each `chant` member gets an `ownership.stack` of its own (#2538, ws-037):
 *   a stack no other member uses is kept, and a shared or missing one gets a
 *   proposed name. The stack stays in the member's chant.config, since
 *   markers carry no member key, so this is printed for the user to apply and
 *   never written.
 *
 * Nothing here runs project code: it reads file names and package.json files.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { formatError, formatSuccess } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import {
  DECLARATION_FILES,
  NAME_PATTERN,
  parseDeclaration,
  resolveGroups,
  rootExclusions,
  WorkspaceReadError,
  isInside,
} from "./declaration";
import { expandGlob } from "./glob";
import { holdsChantProject } from "./kinds";
import { gitTop, skippedDir, workingTree, type WorkspaceTree } from "./tree";

const USAGE = "chant workspace init [dir] [--name <name>] [--yes] [--verbose]";

/** Directory names whose children are examples or test fixtures, not members. */
const EXAMPLE_DIRS = new Map<string, "examples" | "fixtures">([
  ["examples", "examples"],
  ["example", "examples"],
  ["samples", "examples"],
  ["test", "fixtures"],
  ["tests", "fixtures"],
  ["fixtures", "fixtures"],
]);

const CONFIG_FILES = new Set(["chant.config.ts", "chant.config.json"]);

/**
 * Test-runner directories (`__fixtures__` and the like). A project inside one
 * is a fixture of the package around it, so it stays with that package.
 */
const SCAFFOLDING = /(^|\/)__[a-z]+__(\/|$)/;

export interface ProposedEntry {
  name: string;
  dir?: string;
  kind: string;
  because?: string;
  glob?: string | string[];
}

/** The ownership stack proposed for one `chant` member (#2538). */
export interface StackProposal {
  member: string;
  dir: string;
  /** The config file the stack is set in, relative to the root. */
  config: string;
  /**
   * The member's `ownership.stack` as written, when it is a plain string in
   * the config. Null when it sets none, or computes it.
   */
  current: string | null;
  /** The stack the member should use; equal to `current` when that is kept. */
  proposed: string;
  /** Why the stack changes: `missing`, `shared` with another member, or `computed`. Absent when kept. */
  reason?: "missing" | "shared" | "computed";
}

export interface Proposal {
  root: string;
  /** The declaration as it would be written. */
  declaration: { name: string; schema: 1; members: ProposedEntry[] };
  /** Directories leaving the root project, with the .ts source files each holds. */
  leaving: { dir: string; owner: string; files: string[] }[];
  /** One ownership stack per `chant` member, all distinct (ws-037). */
  stacks: StackProposal[];
}

// ── Files ────────────────────────────────────────────────────────────────────

/** Every file under `root`, relative and `/`-separated: git's view when in a repository, else a walk. */
function listFiles(root: string): string[] {
  if (gitTop(root)) {
    try {
      const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: root,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 512 * 1024 * 1024,
      });
      return out
        .split("\0")
        .filter(Boolean)
        .filter((f) => !f.split("/").some((s) => skippedDir(s)) && existsSync(join(root, f)));
    } catch {
      // Fall through to the walk.
    }
  }
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!skippedDir(e.name)) walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) {
        out.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  walk(root, "");
  return out;
}

const dirOf = (file: string): string => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");

/** Keep only the directories no other kept directory contains. */
function outermost(dirs: Iterable<string>): string[] {
  const kept: string[] = [];
  for (const d of [...new Set(dirs)].sort()) {
    if (!kept.some((k) => isInside(d, k))) kept.push(d);
  }
  return kept;
}

// ── Names ────────────────────────────────────────────────────────────────────

export function sanitizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

function readPackage(tree: WorkspaceTree, dir: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(tree.read(dir ? `${dir}/package.json` : "package.json")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The workspace's name: `--name`, else the git remote's repository name, else the root package, else the directory. */
function workspaceName(root: string, tree: WorkspaceTree, given?: string): string {
  if (given) return given;
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const repo = sanitizeName(url.replace(/\.git$/, "").split(/[/:]/).pop() ?? "");
    if (repo) return repo;
  } catch {
    // No remote.
  }
  const pkg = readPackage(tree, "");
  if (typeof pkg?.name === "string") {
    const n = sanitizeName(pkg.name.replace(/^@[^/]+\//, ""));
    if (n) return n;
  }
  return sanitizeName(basename(root)) || "workspace";
}

/** A member's name from its package.json, dropping the scope and the workspace's own prefix, else from its directory. */
function memberName(tree: WorkspaceTree, dir: string, workspace: string): string {
  const pkg = readPackage(tree, dir);
  if (typeof pkg?.name === "string") {
    let n = pkg.name.replace(/^@[^/]+\//, "");
    if (n.startsWith(`${workspace}-`)) n = n.slice(workspace.length + 1);
    n = sanitizeName(n);
    if (n && n !== workspace) return n;
  }
  if (dir === "") return "root";
  return sanitizeName(basename(dir)) || "member";
}

function uniqueName(name: string, taken: Set<string>): string {
  let n = name;
  for (let i = 2; taken.has(n); i++) n = `${name.slice(0, 37)}-${i}`;
  taken.add(n);
  return n;
}

// ── Ownership stacks ─────────────────────────────────────────────────────────

/** A string literal in TS or JSON source. */
const STRING = String.raw`(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|\`([^\`$\\]*)\`)`;
const TS_STACK = new RegExp(String.raw`\bownership\s*:\s*\{[^{}]*?\bstack\s*:\s*` + STRING);
const TS_OWNERSHIP = /\bownership\s*:/;

/**
 * A member's `ownership.stack` read from its config's text, without running
 * it: `{ stack }` when it is a plain string, `{ computed: true }` when the
 * config has an ownership block whose stack is not one, and `{}` when it sets
 * none.
 */
export function readOwnershipStack(tree: WorkspaceTree, dir: string): { config: string; stack?: string; computed?: boolean } | undefined {
  for (const name of ["chant.config.ts", "chant.config.json"]) {
    const config = dir ? `${dir}/${name}` : name;
    if (tree.stat(config) !== "file") continue;
    const text = tree.read(config);
    if (name.endsWith(".json")) {
      try {
        const stack = (JSON.parse(text) as { ownership?: { stack?: unknown } }).ownership?.stack;
        return typeof stack === "string" ? { config, stack } : { config };
      } catch {
        return { config };
      }
    }
    const m = TS_STACK.exec(text);
    if (m) return { config, stack: m[1] ?? m[2] ?? m[3] };
    return TS_OWNERSHIP.test(text) && /\bstack\s*:/.test(text) ? { config, computed: true } : { config };
  }
  return undefined;
}

/** A stack name from a member name: the name itself, else the name with a number, avoiding `taken`. */
function freeStack(name: string, taken: Set<string>): string {
  let s = name;
  for (let i = 2; taken.has(s); i++) s = `${name}-${i}`;
  return s;
}

/**
 * One distinct stack per `chant` member, in declaration order, so the root
 * member and then the outermost directories keep theirs first. A stack only
 * one member uses is kept. A shared stack stays with the first member using
 * it, and the others get their member name. A member with no stack, or one
 * the config computes, gets its member name too. A proposed name never takes
 * a stack another member already sets.
 */
export function proposeStacks(tree: WorkspaceTree, members: { name: string; dir: string; kind: string }[]): StackProposal[] {
  const chant = members
    .filter((m) => m.kind === "chant")
    .map((m) => ({ m, read: readOwnershipStack(tree, m.dir === "." ? "" : m.dir) }))
    .filter((x): x is { m: (typeof members)[number]; read: NonNullable<typeof x.read> } => x.read !== undefined);
  const setBy = new Map<string, string[]>();
  for (const { m, read } of chant) if (read.stack) setBy.set(read.stack, [...(setBy.get(read.stack) ?? []), m.name]);
  const taken = new Set<string>();
  const out: StackProposal[] = [];
  for (const { m, read } of chant) {
    const current = read.stack ?? null;
    const base = { member: m.name, dir: m.dir, config: read.config, current };
    if (current !== null && !taken.has(current)) {
      taken.add(current);
      out.push({ ...base, proposed: current });
      continue;
    }
    // Avoid every stack a member sets, so no rename lands on a later member's.
    const proposed = freeStack(m.name, new Set([...taken, ...setBy.keys()]));
    taken.add(proposed);
    out.push({ ...base, proposed, reason: current !== null ? "shared" : read.computed ? "computed" : "missing" });
  }
  return out;
}

// ── Examples ─────────────────────────────────────────────────────────────────

/** The example match holding `dir`: the directory just below its last examples-style segment, if any. */
function exampleMatch(dir: string): { match: string; parent: string } | undefined {
  const segs = dir.split("/");
  for (let k = segs.length - 2; k >= 0; k--) {
    if (EXAMPLE_DIRS.has(segs[k])) return { match: segs.slice(0, k + 2).join("/"), parent: segs.slice(0, k + 1).join("/") };
  }
  return undefined;
}

function dependsOnChant(tree: WorkspaceTree, dir: string): boolean {
  const pkg = readPackage(tree, dir);
  if (!pkg) return false;
  return ["dependencies", "devDependencies", "peerDependencies"].some((f) => {
    const deps = pkg[f];
    return !!deps && typeof deps === "object" && Object.keys(deps).some((d) => d === "@intentius/chant" || d.startsWith("@intentius/chant-lexicon-"));
  });
}

/**
 * Globs covering `matches`. A tree whose subdirectories are mostly matches
 * gets `<parent>/*`, and parents that differ in one segment merge into one
 * glob with `*` there, when the merged glob claims no member. A tree that is
 * mostly something else lists its matches one by one.
 */
function exampleGlobs(tree: WorkspaceTree, matches: string[], memberDirs: string[]): string[] {
  const byParent = new Map<string, string[]>();
  for (const m of matches) {
    const parent = dirOf(m);
    byParent.set(parent, [...(byParent.get(parent) ?? []), m]);
  }
  const wide: string[] = [];
  const explicit: string[] = [];
  for (const [parent, ms] of byParent) {
    const subdirs = (tree.list(parent) ?? []).filter((e) => e.type === "dir" && !skippedDir(e.name)).length;
    if (ms.length * 2 >= subdirs) wide.push(parent);
    else explicit.push(...ms);
  }
  const safe = (glob: string): boolean =>
    expandGlob(tree, glob).every((d) => !memberDirs.some((m) => m !== "" && isInside(m, d)) && (matches.includes(d) || !holdsChantProject(tree, d)));

  const globs: string[] = [];
  const left = new Set(wide);
  // Try every one-segment wildcard, largest merge first.
  const candidates = new Map<string, string[]>();
  for (const p of wide) {
    const segs = p.split("/");
    for (let i = 0; i < segs.length - 1; i++) {
      const pattern = [...segs.slice(0, i), "*", ...segs.slice(i + 1)].join("/");
      candidates.set(pattern, [...(candidates.get(pattern) ?? []), p]);
    }
  }
  for (const [pattern, parents] of [...candidates].sort((a, b) => b[1].length - a[1].length)) {
    const open = parents.filter((p) => left.has(p));
    if (open.length < 2 || !safe(`${pattern}/*`)) continue;
    globs.push(`${pattern}/*`);
    for (const p of open) left.delete(p);
  }
  for (const p of left) globs.push(`${p}/*`);
  // Explicit matches a glob already covers need no entry of their own.
  const covered = new Set(globs.flatMap((g) => expandGlob(tree, g)));
  for (const m of explicit) if (!covered.has(m)) globs.push(m);
  return globs.sort();
}

/** The group a glob belongs to: `examples`, `fixtures`, or prefixed by the tree it sits in, such as `lexicon-examples`. */
function groupName(glob: string): string {
  const segs = glob.split("/");
  let k = segs.length - 1;
  while (k > 0 && !EXAMPLE_DIRS.has(segs[k])) k--;
  const base = EXAMPLE_DIRS.get(segs[k]) ?? "examples";
  const words: string[] = [];
  for (let i = 0; i < k; i++) {
    if (segs[i] === "*" || EXAMPLE_DIRS.has(segs[i])) continue;
    words.push(segs[i + 1] === "*" ? segs[i].replace(/s$/, "") : segs[i]);
  }
  return sanitizeName([...words, base].join("-")) || base;
}

// ── The proposal ─────────────────────────────────────────────────────────────

export function proposeWorkspace(root: string, options: { name?: string } = {}): Proposal {
  const tree = workingTree(root);
  const files = listFiles(root);
  const dirsWith = (names: (n: string) => boolean) => new Set(files.filter((f) => names(f.slice(f.lastIndexOf("/") + 1))).map(dirOf));

  const name = workspaceName(root, tree, options.name);
  const configDirs = new Set([...dirsWith((n) => CONFIG_FILES.has(n))].filter((d) => !SCAFFOLDING.test(d)));
  const declDirs = dirsWith((n) => (DECLARATION_FILES as readonly string[]).includes(n));
  const pkgDirs = dirsWith((n) => n === "package.json");

  const nested = outermost([...declDirs].filter((d) => d !== ""));
  const notNested = (d: string) => !nested.some((n) => isInside(d, n));

  const projects = outermost([...configDirs].filter((d) => d !== "" && notNested(d)));
  const matches = new Set<string>();
  const chantMembers: string[] = [];
  for (const p of projects) {
    const ex = exampleMatch(p);
    if (ex) matches.add(ex.match);
    else chantMembers.push(p);
  }
  // Examples with no config name their lexicon in package.json.
  for (const d of pkgDirs) {
    const ex = d === "" || SCAFFOLDING.test(d) ? undefined : exampleMatch(d);
    if (ex && ex.match === d && notNested(d) && dependsOnChant(tree, d)) matches.add(ex.match);
  }
  // A match holding a member's project would put a member inside a group.
  for (const m of [...matches]) if (chantMembers.some((c) => isInside(c, m) || isInside(m, c))) matches.delete(m);

  const npmWorkspaces = new Set<string>();
  const rootPkg = readPackage(tree, "");
  const ws = rootPkg?.workspaces;
  const wsGlobs = Array.isArray(ws) ? ws : ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages) ? (ws as { packages: unknown[] }).packages : [];
  for (const g of wsGlobs) if (typeof g === "string" && !g.startsWith("!")) for (const d of expandGlob(tree, g.replace(/^\.\//, "").replace(/\/$/, ""))) npmWorkspaces.add(d);

  const claimed = (d: string) =>
    !notNested(d) ||
    [...matches].some((m) => isInside(d, m)) ||
    chantMembers.some((c) => isInside(d, c) || isInside(c, d)) ||
    exampleMatch(d) !== undefined;
  const packages = outermost([...pkgDirs].filter((d) => d !== "" && !claimed(d)));

  const taken = new Set<string>([name]);
  const entries: (ProposedEntry & { sort: string })[] = [];
  if (configDirs.has("")) entries.push({ sort: "", name: uniqueName(memberName(tree, "", name), taken), dir: ".", kind: "chant" });
  for (const d of nested) entries.push({ sort: d, name: uniqueName(memberName(tree, d, name), taken), dir: d, kind: "workspace" });
  for (const d of chantMembers) entries.push({ sort: d, name: uniqueName(memberName(tree, d, name), taken), dir: d, kind: "chant" });
  for (const d of packages) {
    entries.push({
      sort: d,
      name: uniqueName(memberName(tree, d, name), taken),
      dir: d,
      kind: "other",
      because: npmWorkspaces.has(d) ? "an npm workspace package with no chant project" : "an npm package with no chant project",
    });
  }
  entries.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  taken.delete(name);

  const memberDirs = entries.map((e) => (e.dir === "." ? "" : e.dir!));
  const byGroup = new Map<string, string[]>();
  for (const g of exampleGlobs(tree, [...matches].sort(), memberDirs)) {
    const n = groupName(g);
    byGroup.set(n, [...(byGroup.get(n) ?? []), g]);
  }
  const groups: ProposedEntry[] = [...byGroup]
    .map(([n, globs]) => ({ name: uniqueName(n, taken), kind: "examples", glob: globs.length === 1 ? globs[0] : globs }))
    .sort((a, b) => ([a.glob].flat()[0] < [b.glob].flat()[0] ? -1 : 1));

  const declaration = {
    name,
    schema: 1 as const,
    members: [...entries.map(({ sort: _sort, ...e }) => e), ...groups],
  };

  // Read the proposal back through the real reader: it must be a valid
  // declaration before anyone is asked to write it.
  const parsed = parseDeclaration(JSON.stringify(declaration), "chant.workspace.json");
  const resolved = resolveGroups(parsed, tree);
  const isSource = (f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".spec.ts");
  const leaving = rootExclusions(parsed, resolved).map((x) => ({
    ...x,
    files: files.filter((f) => isInside(f, x.dir) && isSource(f)),
  }));
  const stacks = proposeStacks(tree, entries.map((e) => ({ name: e.name, dir: e.dir!, kind: e.kind })));
  return { root, declaration, leaving, stacks };
}

// ── The command ──────────────────────────────────────────────────────────────

function formatLeaving(proposal: Proposal, verbose: boolean): string[] {
  const lines: string[] = [];
  if (proposal.leaving.length === 0) {
    lines.push("No directory leaves the root project.");
    return lines;
  }
  lines.push("Once the file exists, these directories leave the root project: chant build, lint, run and audit");
  lines.push("at the root stop reading them, and the member or example group named beside each takes them over.");
  lines.push("");
  // Group matches are summed per group; members get a row each.
  const rows: { label: string; owner: string; files: string[] }[] = [];
  const groupNames = new Set(proposal.declaration.members.filter((m) => m.kind === "examples").map((m) => m.name));
  for (const x of proposal.leaving) {
    if (groupNames.has(x.owner) && !verbose) {
      const row = rows.find((r) => r.owner === x.owner);
      if (row) {
        row.files.push(...x.files);
        row.label = `${Number(row.label.split(" ")[0]) + 1} directories`;
        continue;
      }
      rows.push({ label: "1 directories", owner: x.owner, files: [...x.files] });
    } else {
      rows.push({ label: x.dir, owner: x.owner, files: x.files });
    }
  }
  for (const r of rows) if (r.label === "1 directories") r.label = "1 directory";
  const w0 = Math.max(9, ...rows.map((r) => r.label.length));
  const w1 = Math.max(5, ...rows.map((r) => r.owner.length));
  lines.push(`  ${"DIRECTORY".padEnd(w0)}  ${"OWNER".padEnd(w1)}  .TS FILES`);
  for (const r of rows) {
    lines.push(`  ${r.label.padEnd(w0)}  ${r.owner.padEnd(w1)}  ${r.files.length}`);
    if (verbose) for (const f of r.files) lines.push(`      ${f}`);
  }
  const total = proposal.leaving.reduce((n, x) => n + x.files.length, 0);
  lines.push("");
  lines.push(`${proposal.leaving.length} director${proposal.leaving.length === 1 ? "y" : "ies"} with ${total} .ts source file${total === 1 ? "" : "s"} leave the root project.${verbose ? "" : " --verbose lists every file."}`);
  return lines;
}

function formatStacks(proposal: Proposal): string[] {
  if (proposal.stacks.length === 0) return [];
  const lines: string[] = [];
  lines.push("Each chant member needs its own ownership.stack: markers carry no member name, and chant workspace");
  lines.push("check fails when two members share one. The stack stays in the member's chant.config, so apply");
  lines.push("the changes below by hand. Renaming a stack that is already deployed changes its resources' markers.");
  lines.push("");
  const w0 = Math.max(6, ...proposal.stacks.map((s) => s.member.length));
  const w1 = Math.max(5, ...proposal.stacks.map((s) => s.proposed.length));
  lines.push(`  ${"MEMBER".padEnd(w0)}  ${"STACK".padEnd(w1)}  CHANGE`);
  for (const s of proposal.stacks) {
    let change = "keep";
    if (s.reason === "missing") change = `set ownership.stack in ${s.config}`;
    if (s.reason === "computed") change = `computed in ${s.config}; make sure it is distinct`;
    if (s.reason === "shared") change = `rename from ${JSON.stringify(s.current)} in ${s.config}, which another member uses`;
    lines.push(`  ${s.member.padEnd(w0)}  ${s.proposed.padEnd(w1)}  ${change}`);
  }
  return lines;
}

async function confirm(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer) => {
    rl.question(question, (answer) => {
      resolveAnswer(/^y(es)?$/i.test(answer.trim()));
      rl.close();
    });
    // EOF without an answer is a no.
    rl.on("close", () => resolveAnswer(false));
  });
}

export async function runWorkspaceInit(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const cwd = process.cwd();
  const root = args.extraPositional ? resolve(args.extraPositional) : (gitTop(cwd) ?? cwd);
  if (!existsSync(root)) {
    console.error(formatError({ message: `${root} does not exist`, hint: USAGE }));
    return 1;
  }
  const existing = DECLARATION_FILES.filter((f) => existsSync(join(root, f)));
  if (existing.length > 0) {
    console.error(
      formatError({
        message: `${join(root, existing[0])} already exists`,
        hint: "Edit it by hand, or run chant workspace ls to see what it declares.",
      }),
    );
    return 1;
  }
  if (args.selectName !== undefined && !NAME_PATTERN.test(args.selectName)) {
    console.error(
      formatError({
        message: `--name ${JSON.stringify(args.selectName)} is not a valid workspace name`,
        hint: "Use lowercase letters, digits and hyphens, starting with a letter or digit, at most 40 characters.",
      }),
    );
    return 1;
  }

  let proposal: Proposal;
  try {
    proposal = proposeWorkspace(root, { name: args.selectName });
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    // The proposal failed its own check; that is a bug in the proposer, but say what it found.
    console.error(formatError({ message: `the proposed declaration is not valid: ${err.describe()}`, hint: "Write chant.workspace.json by hand for now." }));
    return 1;
  }

  const target = join(root, "chant.workspace.json");
  const text = `${JSON.stringify(proposal.declaration, null, 2)}\n`;
  console.log(`Proposed ${target}:`);
  console.log("");
  console.log(text);
  for (const line of formatLeaving(proposal, !!args.verbose)) console.log(line);
  console.log("");
  const stackLines = formatStacks(proposal);
  if (stackLines.length > 0) {
    for (const line of stackLines) console.log(line);
    console.log("");
  }

  let write = !!args.yes;
  if (!write) {
    if (!process.stdin.isTTY) {
      console.log("Nothing written. Re-run with --yes to write it, or save the proposal above and edit it first.");
      return 0;
    }
    write = await confirm("Write chant.workspace.json? [y/N] ");
  }
  if (!write) {
    console.log("Nothing written.");
    return 0;
  }
  writeFileSync(target, text, { flag: "wx" });
  console.log(formatSuccess(`Wrote ${target}. chant workspace ls lists what it declares.`));
  return 0;
}
