/**
 * `@intentius/chant/planned-files` (#4966): the files a product's init or
 * render plans, written in one call, and the generated files it no longer
 * renders.
 *
 * Each product carried its own: terragucci's `init.ts` plans a
 * `FileChange` per file and writes or unlinks them in a loop, with a
 * `chmodSync` beside its image recipe's writes; plywood's `init.ts` `put`
 * writes a file when it differs; sql-yodeler's `yodel ci` finds the
 * pipeline files that open with its header and removes the ones it no
 * longer renders (its #348).
 *
 * - {@link planFile} plans one file against what is on disk, its mode
 *   included, and writes nothing, so a dry run prints the plan as it is.
 *   Its content is text, or bytes for a file such as terragucci's
 *   `registry edge` bundles, compared byte for byte (#5006).
 * - {@link planRemoval} plans the removal of a file an earlier run wrote.
 * - {@link writePlannedFiles} writes the plan: each directory made, each
 *   file's mode set, each removed file unlinked, an unchanged one left as
 *   it is.
 * - {@link staleGeneratedFiles} lists the files under some directories that
 *   open with a product's header and that the product no longer renders.
 *
 * `@intentius/chant/ref-gate-init` writes its plan with
 * {@link writePlannedFiles}.
 *
 * This module imports only Node's own modules.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What a planned file holds: text, or bytes such as a bundle or a zip, written as they are (#5006). A `Buffer` is a `Uint8Array`. */
export type PlannedContent = string | Uint8Array;

/** One planned file. Its content is text unless the plan was made with bytes (#5006). */
export interface PlannedFile<C extends PlannedContent = string> {
  /** Where it is written. Absolute, or relative to the process's directory. */
  path: string;
  /** `removed`: a file an earlier run wrote that this one no longer asks for. */
  status: "created" | "updated" | "unchanged" | "removed";
  /** The text or bytes to write; empty text for a removal. */
  content: C;
  /** The permission bits to set, such as `0o755` for a script. Unset, a new file gets the process's default and an existing one keeps its own. */
  mode?: number;
  /** In the git directory or otherwise never committed, such as a hook. */
  local?: boolean;
}

/** The permission bits of the file at `path`, or undefined when there is none. */
function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

/** Whether the file at `path` holds `content`: text compared as UTF-8 text, bytes compared byte for byte (#5006). */
function holds(path: string, content: PlannedContent): boolean {
  if (typeof content === "string") return readFileSync(path, "utf-8") === content;
  return Buffer.from(content.buffer, content.byteOffset, content.byteLength).equals(readFileSync(path));
}

/**
 * Plan `content` at `path`: `created` when there is no file, `unchanged`
 * when the file holds the content (and, with `mode`, has that mode),
 * `updated` otherwise. Writes nothing. Content given as bytes is compared
 * with the file byte for byte, and the plan carries the bytes (#5006).
 */
export function planFile(path: string, content: string, extra?: Pick<PlannedFile, "mode" | "local">): PlannedFile;
export function planFile(path: string, content: Uint8Array, extra?: Pick<PlannedFile, "mode" | "local">): PlannedFile<Uint8Array>;
export function planFile(path: string, content: PlannedContent, extra?: Pick<PlannedFile, "mode" | "local">): PlannedFile<PlannedContent>;
export function planFile(path: string, content: PlannedContent, extra: Pick<PlannedFile, "mode" | "local"> = {}): PlannedFile<PlannedContent> {
  const own = { ...(extra.mode !== undefined ? { mode: extra.mode } : {}), ...(extra.local ? { local: true } : {}) };
  if (!existsSync(path)) return { path, status: "created", content, ...own };
  const same = holds(path, content) && (extra.mode === undefined || modeOf(path) === extra.mode);
  return { path, status: same ? "unchanged" : "updated", content, ...own };
}

/** Plan the removal of the file at `path`; undefined when there is nothing there to remove. */
export function planRemoval(path: string): PlannedFile | undefined {
  return existsSync(path) ? { path, status: "removed", content: "" } : undefined;
}

/**
 * Write a plan: each created or updated file written, its directory made
 * and its mode set; each removed file unlinked; an unchanged file not
 * touched. A removed file that is already gone is not an error. Bytes
 * are written as they are (#5006).
 */
export function writePlannedFiles(files: readonly Pick<PlannedFile<PlannedContent>, "path" | "status" | "content" | "mode">[]): void {
  for (const f of files) {
    if (f.status === "unchanged") continue;
    if (f.status === "removed") {
      if (existsSync(f.path)) unlinkSync(f.path);
      continue;
    }
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
    if (f.mode !== undefined) chmodSync(f.path, f.mode);
  }
}

export interface StaleGeneratedOptions {
  /** The directory the paths are relative to: a product's checkout. */
  root: string;
  /** Directories, relative to `root`, whose files (not their subdirectories) may be generated. */
  dirs?: readonly string[];
  /** Single files, relative to `root`, that may be generated, such as `.gitlab-ci.yml`. */
  files?: readonly string[];
  /** The names in `dirs` to look at. Default every file. */
  match?: RegExp;
  /** The product's header: its first line, which a generated file opens with, or a test of the file's text. */
  header: string | ((text: string) => boolean);
  /** The paths, relative to `root` and written with `/`, the product renders now. */
  rendered: Iterable<string>;
}

/**
 * The files under `dirs` and among `files` that open with the product's
 * header and that it does not render now, relative to `root`, in the order
 * found (each directory's names sorted). A file without the header is the
 * person's own and never listed.
 */
export function staleGeneratedFiles(options: StaleGeneratedOptions): string[] {
  const { root } = options;
  const header = options.header;
  const isGenerated = typeof header === "string" ? (text: string) => text.split(/\r?\n/, 1)[0] === header : header;
  const candidates = [...(options.files ?? [])];
  for (const d of options.dirs ?? []) {
    const abs = join(root, d);
    if (!existsSync(abs)) continue;
    const prefix = d.replace(/\/+$/, "");
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.isFile() && (!options.match || options.match.test(e.name))) candidates.push(prefix === "" || prefix === "." ? e.name : `${prefix}/${e.name}`);
    }
  }
  const rendered = new Set(options.rendered);
  const out: string[] = [];
  for (const p of candidates) {
    if (rendered.has(p) || out.includes(p)) continue;
    const abs = join(root, p);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    if (isGenerated(readFileSync(abs, "utf-8"))) out.push(p);
  }
  return out;
}

export { PLANNED_BYTES_FLOOR, PLANNED_FILES_FLOOR } from "./release-floors";
