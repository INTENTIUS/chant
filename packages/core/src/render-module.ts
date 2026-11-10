/**
 * #4950: render a module's file-text export.
 *
 * A product keeps some generated files as the text a TypeScript function
 * returns: plywood's `dockerfiles()` in `src/images.ts` gives each image's
 * Dockerfile by its path from the repository root, and a schema or a set of
 * dashboards can be the same. plywood bundled each such module with esbuild
 * (`build-images.mjs`, `build-schema.mjs`) only to call that export and write
 * the files. Here chant imports the module itself, with the TypeScript loader
 * and chant's own modules served as the running CLI, calls the export, and
 * writes each file below an output root:
 *
 * - `chant dev render <module> <export> [--output <root>]` writes them in
 *   place (the root is the working directory unless `--output` names one);
 *   under `chant dev generated-check` they go to the render tree.
 * - a `chantGenerated` render of the module kind (`{ "module", "export" }`)
 *   renders them into the check's render tree and compares them.
 *
 * The export is a `{ path: text }` object, or a function, async or not, that
 * returns one when called with no arguments. Each path is relative, with `/`
 * between segments and no `..`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { importModule } from "./discovery/import";

/** Files by their path below the output root. */
export type RenderedFiles = Record<string, string>;

/** Whether `path` is one an export may name: relative, `/`-separated, with no `.` or `..` segment. */
function isRenderedPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/**
 * Import `modulePath` (resolved from `cwd`) and return the files its export
 * `exportName` renders. Throws, naming the module and export, when the export
 * is missing, is not files, or names a path outside the root.
 */
export async function renderModuleFiles(modulePath: string, exportName: string, cwd = process.cwd()): Promise<RenderedFiles> {
  const at = resolve(cwd, modulePath);
  const where = `${modulePath} export ${exportName}`;
  const mod = await importModule(at);
  if (!(exportName in mod)) throw new Error(`${modulePath} has no export named ${exportName}`);
  const exported = mod[exportName];
  const value = typeof exported === "function" ? await (exported as () => unknown)() : exported;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be, or return, an object of file paths to their text`);
  const files: RenderedFiles = {};
  for (const [path, text] of Object.entries(value as Record<string, unknown>)) {
    if (!isRenderedPath(path)) throw new Error(`${where} names ${JSON.stringify(path)}, which is not a relative path inside the output root`);
    if (typeof text !== "string") throw new Error(`${where} gives ${path} a ${text === null ? "null" : typeof text}, not its text`);
    files[path] = text;
  }
  if (Object.keys(files).length === 0) throw new Error(`${where} renders no files`);
  return files;
}

/**
 * Write each file below `root`, creating its directories. `place` maps the
 * absolute path before the write (`renderPathOf`, under a check). Returns
 * the paths written, in the export's order.
 */
export function writeRenderedFiles(root: string, files: RenderedFiles, place: (path: string) => string = (p) => p): string[] {
  const written: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    const target = place(join(root, path));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    written.push(target);
  }
  return written;
}
