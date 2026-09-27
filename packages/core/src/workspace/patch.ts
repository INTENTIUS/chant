/**
 * The hunks of a diff: `chant workspace patch <base>..<head>|<base>...<head>|<commit>
 * [--path <p>...] [--max-bytes <n>] [--json]`.
 *
 * `check --changes` maps the paths a diff changes to records and prints no
 * lines of it. A reader showing what a work branch or a commit did needs the
 * lines, and a reader that runs no git of its own (hud) gets them here. The
 * range is read as `check --changes` reads one, except that a lone revision
 * is that commit against its first parent, or against the empty tree for a
 * root commit, since a reader drawing one commit wants that commit's change.
 *
 * Each changed file under the workspace root is listed, with renames
 * followed, its added and deleted line counts, and its hunks. A file's hunk
 * text stops at `maxBytes` (64 KiB unless given), and all files' together at
 * sixteen times that; a file cut short, or left without hunks once the total
 * is spent, says `truncated`. A binary file has counts of null and no hunks.
 * Git is read through a local `git` subprocess only: no fetch, no network.
 */

import { execFileSync } from "node:child_process";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { readDeclaration, readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError } from "./declaration";
import { isWorkspacePath } from "./record-assets";
import type { ReasonCode } from "./reason-codes";
import { joinPath } from "./tree";
import { locateWorkspace } from "./which-chant";

/** The version of the `patch` document this chant writes. */
export const PATCH_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the document, shipped beside this file. */
export const PATCH_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/patch/v1/patch.schema.json";

/** Why the read failed as a whole. */
export const PATCH_ERROR_CODES = [
  ...WORKSPACE_ERROR_CODES,
  /** A --path is not a relative path inside the workspace. */
  "patch-path-invalid",
] as const satisfies readonly ReasonCode[];
export type PatchErrorCode = (typeof PATCH_ERROR_CODES)[number];

/** The hunk text one file gets unless `maxBytes` says otherwise. */
export const PATCH_FILE_BYTES = 64 * 1024;

/** The hunk text every file gets together, as a multiple of the per-file cap. */
export const PATCH_TOTAL_FACTOR = 16;

/** Git's empty tree, the base of a root commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

class PatchError extends Error {
  constructor(
    readonly code: PatchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PatchError";
  }
}

export interface PatchHunk {
  /** The `@@` line as git writes it. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each line with its leading ` `, `+`, `-` or `\`, without its newline. Cut short when the file is truncated. */
  lines: string[];
}

export interface PatchFile {
  /** From the workspace root. */
  path: string;
  change: "added" | "modified" | "deleted" | "renamed" | "copied";
  /** For a rename or a copy, the path it came from. */
  from: string | null;
  binary: boolean;
  /** Lines added and deleted, as git counts them; null for a binary file. */
  additions: number | null;
  deletions: number | null;
  /** How many hunks git wrote for the file; hunks may hold fewer when truncated. */
  hunkCount: number;
  /** The bytes of hunk text git wrote for the file, headers included, before any cut. */
  bytes: number;
  hunks: PatchHunk[];
  /** Whether hunks holds less than git wrote. */
  truncated: boolean;
}

interface Head {
  $schema: string;
  contract: number;
  chant: string;
}

export type PatchDocument =
  | (Head & {
      workspace: { name: string; root: string };
      /** What was asked, and the two commits compared. `form` says how the spec was read. */
      range: { spec: string; form: "range" | "merge-base" | "commit"; base: string; head: string };
      /** The --path filters, from the workspace root; empty for the whole workspace. */
      paths: string[];
      limits: { fileBytes: number; totalBytes: number };
      files: PatchFile[];
      summary: { files: number; additions: number; deletions: number; truncated: boolean };
    })
  | (Head & { error: { code: PatchErrorCode; message: string } });

export interface PatchQuery {
  cwd: string;
  /** `<base>..<head>`, `<base>...<head>`, or one commit. */
  range: string;
  /** Paths from the workspace root: a file, or a directory for everything under it. */
  paths?: string[];
  /** The hunk text one file gets. */
  maxBytes?: number;
}

export interface PatchResult {
  doc: PatchDocument;
  failed: boolean;
}

function git(top: string, args: string[]): string {
  return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 * 1024 });
}

function commitOf(top: string, rev: string): string {
  if (rev === "" || rev.startsWith("-")) throw new PatchError("revision-unknown", `the patch needs <base>..<head>, <base>...<head> or a commit, and ${JSON.stringify(rev)} is not a revision`);
  try {
    return git(top, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).trim();
  } catch {
    throw new PatchError("revision-unknown", `${rev} is no commit in this repository`);
  }
}

function resolveRange(top: string, spec: string): { form: "range" | "merge-base" | "commit"; base: string; head: string } {
  const three = spec.indexOf("...");
  if (three >= 0) {
    const head = commitOf(top, spec.slice(three + 3) || "HEAD");
    const other = commitOf(top, spec.slice(0, three));
    try {
      return { form: "merge-base", base: git(top, ["merge-base", other, head]).trim(), head };
    } catch {
      throw new PatchError("revision-unknown", `${spec}: the two revisions have no merge base`);
    }
  }
  const two = spec.indexOf("..");
  if (two >= 0) return { form: "range", base: commitOf(top, spec.slice(0, two)), head: commitOf(top, spec.slice(two + 2) || "HEAD") };
  const head = commitOf(top, spec);
  let base = EMPTY_TREE;
  try {
    base = git(top, ["rev-parse", "--verify", "--quiet", `${head}^1`]).trim();
  } catch {
    // A root commit: against the empty tree.
  }
  return { form: "commit", base, head };
}

/** Each changed file, from the repository root, with its counts; renames and copies followed. */
function changedFiles(top: string, base: string, head: string, pathspecs: string[]): Omit<PatchFile, "hunkCount" | "bytes" | "hunks" | "truncated">[] {
  const spec = ["--", ...pathspecs];
  const status = git(top, ["diff", "--name-status", "-z", "-M", "--no-color", base, head, ...spec]).split("\0");
  const counts = git(top, ["diff", "--numstat", "-z", "-M", "--no-color", base, head, ...spec]).split("\0");
  const numstat = new Map<string, { additions: number | null; deletions: number | null }>();
  for (let i = 0; i < counts.length && counts[i] !== ""; ) {
    const [a, d, path] = counts[i].split("\t");
    const n = { additions: a === "-" ? null : Number(a), deletions: d === "-" ? null : Number(d) };
    if (path === "") {
      // A rename or a copy: the old path, then the new.
      numstat.set(counts[i + 2], n);
      i += 3;
    } else {
      numstat.set(path, n);
      i += 1;
    }
  }
  const out: Omit<PatchFile, "hunkCount" | "bytes" | "hunks" | "truncated">[] = [];
  for (let i = 0; i < status.length && status[i] !== ""; ) {
    const s = status[i];
    const paired = s.startsWith("R") || s.startsWith("C");
    const path = paired ? status[i + 2] : status[i + 1];
    const from = paired ? status[i + 1] : null;
    const change = s.startsWith("R") ? "renamed" : s.startsWith("C") ? "copied" : s === "A" ? "added" : s === "D" ? "deleted" : "modified";
    const n = numstat.get(path) ?? { additions: null, deletions: null };
    out.push({ path, change, from, binary: n.additions === null, ...n });
    i += paired ? 3 : 2;
  }
  return out;
}

/** The hunks of one file's diff text, and the bytes of hunk text, before any cut. */
function parseHunks(text: string): { hunks: PatchHunk[]; bytes: number } {
  const hunks: PatchHunk[] = [];
  let bytes = 0;
  let current: PatchHunk | null = null;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      current = { header: line, oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), lines: [] };
      hunks.push(current);
      bytes += Buffer.byteLength(line) + 1;
    } else if (current && /^[ +\-\\]/.test(line)) {
      current.lines.push(line);
      bytes += Buffer.byteLength(line) + 1;
    }
  }
  return { hunks, bytes };
}

/**
 * Each file's section of the diff, in the order `--name-status` lists the
 * files: one `git diff` for the whole range, split at its `diff --git` lines.
 * When the count of sections is not the count of files, each file's diff is
 * read on its own instead.
 */
function fileSections(top: string, base: string, head: string, pathspecs: string[], files: { path: string; from: string | null }[]): string[] {
  const diff = (spec: string[]) => git(top, ["diff", "--no-color", "--no-ext-diff", "-M", base, head, "--", ...spec]);
  const text = diff(pathspecs);
  const sections = text === "" ? [] : text.split(/^(?=diff --git )/m).filter((x) => x.startsWith("diff --git "));
  if (sections.length === files.length) return sections;
  return files.map((f) => diff(f.from ? [f.from, f.path] : [f.path]));
}

/** The hunks cut to `budget` bytes: whole hunks while they fit, then the lines of the next that fit. */
function cut(hunks: PatchHunk[], budget: number): { hunks: PatchHunk[]; used: number; truncated: boolean } {
  const out: PatchHunk[] = [];
  let used = 0;
  for (const h of hunks) {
    const header = Buffer.byteLength(h.header) + 1;
    if (used + header > budget) return { hunks: out, used, truncated: true };
    const kept: string[] = [];
    used += header;
    for (const l of h.lines) {
      const n = Buffer.byteLength(l) + 1;
      if (used + n > budget) {
        out.push({ ...h, lines: kept });
        return { hunks: out, used, truncated: true };
      }
      kept.push(l);
      used += n;
    }
    out.push(h);
  }
  return { hunks: out, used, truncated: false };
}

/** Build the document. Never throws a {@link WorkspaceReadError}. */
export async function workspacePatch(query: PatchQuery): Promise<PatchResult> {
  const head: Head = { $schema: PATCH_OUTPUT_SCHEMA_ID, contract: PATCH_CONTRACT_VERSION, chant: readerVersion() };
  try {
    return { doc: run(query, head), failed: false };
  } catch (err) {
    if (err instanceof PatchError || err instanceof WorkspaceReadError) {
      return { doc: { ...head, error: { code: err.code as PatchErrorCode, message: err.message } }, failed: true };
    }
    throw err;
  }
}

function run(query: PatchQuery, head: Head): Exclude<PatchDocument, { error: unknown }> {
  const located = locateWorkspace(query.cwd);
  const top = located.top;
  if (!top) throw new PatchError("not-a-git-repository", "the patch read reads a git diff, and this directory is not in a git repository");
  const declaration = readDeclaration(located.tree, "", { rootChant: true });
  const prefix = located.root === "." ? "" : located.root;
  const paths = (query.paths ?? []).map((p) => p.replace(/\/+$/, ""));
  for (const p of paths) if (p !== "." && !isWorkspacePath(p)) throw new PatchError("patch-path-invalid", `--path ${p} is not a relative path inside the workspace`);
  const pathspecs = paths.length === 0 ? [prefix === "" ? "." : prefix] : paths.map((p) => (joinPath(prefix, p) === "" ? "." : joinPath(prefix, p)));
  const range = resolveRange(top, query.range);
  const fileBytes = query.maxBytes ?? PATCH_FILE_BYTES;
  const totalBytes = fileBytes * PATCH_TOTAL_FACTOR;
  const fromWorkspace = (full: string) => (prefix === "" ? full : full.slice(prefix.length + 1));

  let left = totalBytes;
  const files: PatchFile[] = [];
  const changed = changedFiles(top, range.base, range.head, pathspecs);
  const sections = changed.length > 0 ? fileSections(top, range.base, range.head, pathspecs, changed) : [];
  for (const [i, f] of changed.entries()) {
    const entry = { ...f, path: fromWorkspace(f.path), from: f.from === null ? null : fromWorkspace(f.from) };
    if (f.binary) {
      files.push({ ...entry, hunkCount: 0, bytes: 0, hunks: [], truncated: false });
      continue;
    }
    const all = parseHunks(sections[i]);
    const kept = cut(all.hunks, Math.min(fileBytes, left));
    left -= kept.used;
    files.push({ ...entry, hunkCount: all.hunks.length, bytes: all.bytes, hunks: kept.hunks, truncated: kept.truncated });
  }
  return {
    ...head,
    workspace: { name: declaration.name, root: located.root },
    range: { spec: query.range, ...range },
    paths,
    limits: { fileBytes, totalBytes },
    files,
    summary: {
      files: files.length,
      additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
      truncated: files.some((f) => f.truncated),
    },
  };
}

const USAGE = "chant workspace patch <base>..<head>|<base>...<head>|<commit> [--path <p>...] [--max-bytes <n>] [--json]";

/** Each file's line, then its hunks as git writes them, then a summary. */
export function formatPatch(doc: Exclude<PatchDocument, { error: unknown }>): string {
  const out = [`patch     ${doc.range.base.slice(0, 8)}..${doc.range.head.slice(0, 8)} (${doc.range.spec}, ${doc.range.form})`];
  for (const f of doc.files) {
    const counts = f.binary ? "binary" : `+${f.additions} -${f.deletions}`;
    out.push(`${f.change.padEnd(9)} ${f.path}${f.from ? ` (from ${f.from})` : ""} ${counts}${f.truncated ? `; truncated, ${f.hunks.length} of ${f.hunkCount} hunks shown` : ""}`);
    for (const h of f.hunks) out.push(h.header, ...h.lines);
  }
  const s = doc.summary;
  out.push(`${s.files} files, +${s.additions} -${s.deletions}${s.truncated ? `; truncated at ${doc.limits.fileBytes} bytes a file, ${doc.limits.totalBytes} in all` : ""}`);
  return out.join("\n");
}

export async function runWorkspacePatch(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const range = args.extraPositional;
  if (!range) {
    console.error(formatError({ message: "chant workspace patch needs a range or a commit", hint: USAGE }));
    return 1;
  }
  const { doc, failed } = await workspacePatch({ cwd: process.cwd(), range, paths: args.paths, maxBytes: args.maxBytes });
  if (args.json) console.log(JSON.stringify(doc, null, 2));
  if ("error" in doc) {
    console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
    return 1;
  }
  if (!args.json) console.log(formatPatch(doc));
  return failed ? 1 : 0;
}
