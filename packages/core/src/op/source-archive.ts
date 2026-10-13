/**
 * A source tree as a release artifact (#2782): one directory of a commit,
 * archived with `git archive`, and read back only when its bytes still hash
 * to the digest a gate approved.
 *
 * `git archive <commit> -- <dir>` gives every entry the commit's own
 * timestamp, so the same commit always archives to the same bytes, and the
 * archive's sha256 names the tree exactly. A release plan carries that digest,
 * the ship gate approves the plan, and whatever ships the release reads the
 * archive through {@link readSourceArchive}, which refuses bytes that do not
 * hash to the approved digest.
 *
 * Pure except for the git and file reads each function names.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** One file of an archived tree. */
export interface SourceFile {
  /** Its path inside the archived directory, with `/` separators. */
  path: string;
  /** Whether git records it executable. */
  executable: boolean;
  data: Buffer;
}

/** A directory of a commit, archived. */
export interface SourceArchive {
  /** `sha256:<hex>` of the archive's bytes. */
  digest: string;
  /** Where the archive was written. */
  archive: string;
  /** The commit it was archived from. */
  commit: string;
  /** The archived directory, relative to the repository root (`.` for the root). */
  dir: string;
  /** Files in it. */
  files: number;
  /** Size of the archive in bytes. */
  bytes: number;
}

export const sha256Digest = (data: Buffer | string): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;

function git(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Archive `dir` (relative to `cwd`) as committed at `ref` (default HEAD) to
 * `out` (default `<cwd>/dist/releases/<commit>.tar`). Uncommitted changes are
 * not in it: a release ships what is committed. Running it again for the same
 * commit writes the same bytes.
 */
export function archiveSourceTree(opts: { dir: string; ref?: string; out?: string; cwd?: string }): SourceArchive {
  const cwd = resolve(opts.cwd ?? process.cwd());
  // git names the root by its real path, so the directory is resolved the same way.
  const root = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).toString("utf-8").trim());
  const commit = git(cwd, ["rev-parse", "--verify", `${opts.ref ?? "HEAD"}^{commit}`]).toString("utf-8").trim();
  const target = resolve(realpathSync(cwd), opts.dir);
  const dir = relative(root, target).split("\\").join("/") || ".";
  if (dir.startsWith("..") || isAbsolute(dir)) throw new Error(`${opts.dir} is outside the repository at ${root}`);
  const spec = dir === "." ? commit : `${commit}:${dir}`;
  try {
    git(root, ["cat-file", "-e", spec]);
  } catch {
    throw new Error(`${dir} is not in commit ${commit.slice(0, 12)}: commit it before releasing it`);
  }
  const data = git(root, ["archive", "--format=tar", commit, "--", dir]);
  const archive = resolve(cwd, opts.out ?? join("dist", "releases", `${commit}.tar`));
  mkdirSync(dirname(archive), { recursive: true });
  writeFileSync(archive, data);
  const files = tarEntries(data).filter((e) => e.type === "file").length;
  return { digest: sha256Digest(data), archive, commit, dir, files, bytes: data.length };
}

interface TarEntry {
  type: "file" | "dir" | "symlink" | "other";
  path: string;
  mode: number;
  data: Buffer;
}

const field = (block: Buffer, at: number, len: number): string => {
  const raw = block.subarray(at, at + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString("utf-8");
};
const octal = (block: Buffer, at: number, len: number): number => parseInt(field(block, at, len).trim() || "0", 8);

/** The records of a pax header: `<len> key=value\n`. */
function paxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const len = parseInt(data.subarray(at, space).toString("utf-8"), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = data.subarray(space + 1, at + len - 1).toString("utf-8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += len;
  }
  return out;
}

/** The entries of a ustar/pax archive, as `git archive` writes one. */
function tarEntries(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let at = 0;
  let pax: Record<string, string> = {};
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const flag = String.fromCharCode(header[156] || 0x30);
    const data = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (flag === "x") {
      pax = paxRecords(data);
      continue;
    }
    if (flag === "g") continue;
    const prefix = field(header, 345, 155);
    const name = pax.path ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    pax = {};
    const type = flag === "0" || flag === "\0" || flag === "7" ? "file" : flag === "5" ? "dir" : flag === "2" ? "symlink" : "other";
    out.push({ type, path: name, mode: octal(header, 100, 8), data: Buffer.from(data) });
  }
  return out;
}

/**
 * The files of an archive `archiveSourceTree` wrote, relative to the directory
 * it archived, once its bytes hash to `digest`. Throws, naming both digests,
 * when they do not: whatever would ship them is not what was approved.
 *
 * A symbolic link in the tree is refused rather than followed or dropped.
 */
export function readSourceArchive(opts: { archive: string; digest: string; dir?: string }): SourceFile[] {
  const data = readFileSync(opts.archive);
  const actual = sha256Digest(data);
  if (actual !== opts.digest) {
    throw new Error(`${opts.archive} is ${actual}, not the approved ${opts.digest}: it is not the tree the release was planned from`);
  }
  const entries = tarEntries(data);
  const dir = opts.dir && opts.dir !== "." ? `${opts.dir.replace(/\/+$/, "")}/` : "";
  const files: SourceFile[] = [];
  for (const e of entries) {
    if (e.type === "dir") continue;
    if (!e.path.startsWith(dir)) throw new Error(`${opts.archive} holds ${e.path}, outside ${dir || "its root"}`);
    const path = e.path.slice(dir.length);
    if (e.type !== "file") throw new Error(`${opts.archive} holds ${path}, which is not a regular file; a source release ships regular files only`);
    files.push({ path, executable: (e.mode & 0o111) !== 0, data: e.data });
  }
  return files;
}
