/**
 * Project-local code generation: typed code a lexicon generates into the
 * project from sources the project declares in `chant.config.ts` (a CRD file,
 * a Helm chart), as opposed to the types a lexicon ships in its package.
 *
 * The split of work:
 *
 * - A lexicon implements {@link ProjectCodegen} (the plugin's
 *   `projectCodegen()` hook). It says what its declared inputs are
 *   ({@link ProjectCodegen.inputs}, offline), renders files from them
 *   ({@link ProjectCodegen.generate}, may fetch), and optionally reads its own
 *   committed output back when a build starts ({@link ProjectCodegen.load}).
 * - Core owns the output directory, writes the files, and records a digest of
 *   the inputs beside them in {@link STAMP_FILE}. `chant generate` is the only
 *   writer.
 * - Every build compares the inputs' digest with the recorded one before it
 *   serializes ({@link checkProjectCodegen}, wired in through the build-root
 *   contributors in ./cli/plugins.ts). A mismatch fails the build. The build
 *   never fetches and never regenerates, so it stays offline and the committed
 *   output is what a fresh clone typechecks against.
 *
 * Output lives in `<codegen.outDir>/<lexicon>/`, default `src/generated/<lexicon>/`,
 * relative to the directory holding `chant.config.*`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "./effect-receipt";
import { GENERATED_MARKER } from "./discovery/files";

/** Default output directory, relative to the project root. */
export const DEFAULT_CODEGEN_OUT_DIR = "src/generated";

/** The file core writes beside a lexicon's generated files: the inputs digest and the file list. */
export const STAMP_FILE = "chant-codegen.json";

/**
 * Header for generated TypeScript. It carries discovery's generated-file
 * marker (`./discovery/files.ts`), so the build and `chant lint` do not treat
 * the generated module as authored source; project files still import it.
 */
export const GENERATED_TS_HEADER = `// ${GENERATED_MARKER}. Run \`chant generate\` to update.`;

/** What a lexicon's project-codegen hooks receive. */
export interface ProjectCodegenContext {
  /** The directory holding `chant.config.*`. Relative paths in the config resolve against it. */
  projectRoot: string;
  /** The resolved project configuration; a lexicon reads its own namespace. */
  config: Record<string, unknown>;
  /** Absolute directory this lexicon's files go in (`<codegen.outDir>/<lexicon>`). */
  outDir: string;
}

/** Extra context for {@link ProjectCodegen.generate}. */
export interface ProjectCodegenGenerateContext extends ProjectCodegenContext {
  /**
   * The fetch remote sources go through. Absent means the global `fetch`.
   * Tests pass a fake so no network is touched.
   */
  fetch?: typeof fetch;
}

/** What {@link ProjectCodegen.generate} returns. */
export interface ProjectCodegenOutput {
  /** File contents keyed by path relative to `outDir`, `/`-separated. */
  files: Record<string, string>;
  /** One line per generated item, printed by `chant generate`. */
  summary?: string[];
}

/**
 * A lexicon's project-local code generation (the plugin's `projectCodegen()`
 * hook).
 */
export interface ProjectCodegen {
  /**
   * The declared inputs, as a JSON value, or `undefined` when the project
   * declares none. Must not touch the network: the build calls it on every
   * run. A local file is described by a hash of its content, a remote source
   * by its pin (a version, a sha256), so editing a local file or changing a
   * pin changes the value. Core hashes the value; the lexicon never sees the
   * digest.
   */
  inputs(ctx: ProjectCodegenContext): Promise<unknown | undefined> | unknown | undefined;
  /** Render the files from the declared inputs. May fetch, through `ctx.fetch`. */
  generate(ctx: ProjectCodegenGenerateContext): Promise<ProjectCodegenOutput>;
  /**
   * Read the committed output back at the start of a build, once the inputs
   * are known to match it. The k8s lexicon registers the generated kinds here
   * so its serializer and the CRD spec checks know them even when discovery
   * ran in a sandboxed child process.
   */
  load?(ctx: ProjectCodegenContext): Promise<void> | void;
}

/** The recorded stamp. */
export interface ProjectCodegenStamp {
  /** `sha256:<hex>` of the canonical JSON of {@link ProjectCodegen.inputs}. */
  inputs: string;
  /** The files written, relative to the lexicon's output directory. */
  files: string[];
}

/** The minimal plugin shape these functions need. */
export interface ProjectCodegenPlugin {
  readonly name: string;
  projectCodegen?(): ProjectCodegen;
}

/** Resolve the output root (`codegen.outDir`, default {@link DEFAULT_CODEGEN_OUT_DIR}) against the project root. */
export function resolveCodegenRoot(projectRoot: string, config: Record<string, unknown>): string {
  const codegen = config.codegen as { outDir?: unknown } | undefined;
  const outDir = typeof codegen?.outDir === "string" && codegen.outDir.length > 0 ? codegen.outDir : DEFAULT_CODEGEN_OUT_DIR;
  return resolve(projectRoot, outDir);
}

/** The context for one lexicon. */
export function projectCodegenContext(
  lexicon: string,
  projectRoot: string,
  config: Record<string, unknown>,
): ProjectCodegenContext {
  return { projectRoot, config, outDir: join(resolveCodegenRoot(projectRoot, config), lexicon) };
}

/** `sha256:<hex>` of a JSON value's canonical form. */
export function digestInputs(inputs: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(inputs)).digest("hex")}`;
}

/** Read a lexicon's stamp, or `undefined` when it has none (or it does not parse). */
export function readStamp(outDir: string): ProjectCodegenStamp | undefined {
  const path = join(outDir, STAMP_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectCodegenStamp>;
    if (typeof parsed.inputs !== "string" || !Array.isArray(parsed.files)) return undefined;
    return { inputs: parsed.inputs, files: parsed.files.filter((f): f is string => typeof f === "string") };
  } catch {
    return undefined;
  }
}

/** One lexicon's result from {@link generateProjectCode}. */
export interface ProjectCodegenResult {
  lexicon: string;
  /** The lexicon's output directory. */
  outDir: string;
  /** `written`: files (re)generated. `removed`: nothing declared, old output deleted. `none`: nothing declared, nothing there. */
  status: "written" | "removed" | "none";
  files: string[];
  summary: string[];
}

/**
 * `chant generate` for one lexicon: render its files, write them, delete
 * files a previous run wrote that this one did not, and record the stamp.
 * With nothing declared, a previous run's output is removed.
 */
export async function generateProjectCode(
  plugin: ProjectCodegenPlugin,
  projectRoot: string,
  config: Record<string, unknown>,
  options: { fetch?: typeof fetch } = {},
): Promise<ProjectCodegenResult | undefined> {
  const codegen = plugin.projectCodegen?.();
  if (!codegen) return undefined;
  const ctx = projectCodegenContext(plugin.name, projectRoot, config);
  const previous = readStamp(ctx.outDir);
  const inputs = await codegen.inputs(ctx);

  if (inputs === undefined) {
    if (!previous) return { lexicon: plugin.name, outDir: ctx.outDir, status: "none", files: [], summary: [] };
    removeFiles(ctx.outDir, [...previous.files, STAMP_FILE]);
    return { lexicon: plugin.name, outDir: ctx.outDir, status: "removed", files: previous.files, summary: [] };
  }

  const output = await codegen.generate({ ...ctx, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const files = Object.keys(output.files).sort();
  for (const file of files) {
    const target = safeJoin(ctx.outDir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, output.files[file]);
  }
  if (previous) {
    const keep = new Set(files);
    removeFiles(ctx.outDir, previous.files.filter((f) => !keep.has(f)));
  }
  const stamp: ProjectCodegenStamp = { inputs: digestInputs(inputs), files };
  mkdirSync(ctx.outDir, { recursive: true });
  writeFileSync(join(ctx.outDir, STAMP_FILE), JSON.stringify(stamp, null, 2) + "\n");
  return { lexicon: plugin.name, outDir: ctx.outDir, status: "written", files, summary: output.summary ?? [] };
}

/** The outcome of {@link checkProjectCodegen} for one lexicon. */
export type ProjectCodegenCheck =
  | { status: "current" | "none" }
  | { status: "missing" | "drift" | "orphan"; message: string };

/**
 * Whether a lexicon's committed output matches its declared inputs. Offline.
 *
 * - `none`: nothing declared, nothing generated.
 * - `current`: the recorded digest matches and every recorded file exists.
 * - `missing`: sources are declared and there is no output (or a recorded file is gone).
 * - `drift`: the declared sources changed since the output was generated.
 * - `orphan`: nothing is declared any more, but generated output remains.
 */
export async function checkProjectCodegen(
  plugin: ProjectCodegenPlugin,
  projectRoot: string,
  config: Record<string, unknown>,
): Promise<ProjectCodegenCheck> {
  const codegen = plugin.projectCodegen?.();
  if (!codegen) return { status: "none" };
  const ctx = projectCodegenContext(plugin.name, projectRoot, config);
  const where = displayPath(projectRoot, ctx.outDir);
  const stamp = readStamp(ctx.outDir);
  const inputs = await codegen.inputs(ctx);

  if (inputs === undefined) {
    if (!stamp) return { status: "none" };
    return {
      status: "orphan",
      message: `${where} holds generated ${plugin.name} code, but chant.config declares no ${plugin.name} sources for it. Run \`chant generate\` to remove it.`,
    };
  }
  if (!stamp) {
    return {
      status: "missing",
      message: `chant.config declares ${plugin.name} sources to generate, but ${where} has no generated code. Run \`chant generate\` and commit the result.`,
    };
  }
  const absent = stamp.files.filter((f) => !existsSync(safeJoin(ctx.outDir, f)));
  if (absent.length > 0) {
    return {
      status: "missing",
      message: `generated ${plugin.name} file(s) missing from ${where}: ${absent.join(", ")}. Run \`chant generate\` and commit the result.`,
    };
  }
  if (stamp.inputs !== digestInputs(inputs)) {
    return {
      status: "drift",
      message: `generated ${plugin.name} code in ${where} is out of date: its declared sources changed since it was generated. Run \`chant generate\` and commit the result.`,
    };
  }
  return { status: "current" };
}

/**
 * The build's side of project codegen for one plugin: check the committed
 * output against the declared inputs, throw on any mismatch, and let the
 * lexicon load its output when it is current. Called once per top-level
 * build, before serialization.
 */
export async function prepareProjectCodegen(
  plugin: ProjectCodegenPlugin,
  projectRoot: string,
  config: Record<string, unknown>,
): Promise<void> {
  const check = await checkProjectCodegen(plugin, projectRoot, config);
  if ("message" in check) throw new Error(check.message);
  if (check.status === "none") return;
  await plugin.projectCodegen?.().load?.(projectCodegenContext(plugin.name, projectRoot, config));
}

function removeFiles(outDir: string, files: string[]): void {
  for (const file of files) {
    rmSync(safeJoin(outDir, file), { force: true });
  }
  pruneEmptyDirs(outDir);
}

/** Remove empty directories under (and including) `dir`. */
function pruneEmptyDirs(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirs(join(dir, entry.name));
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

/** Join a recorded relative path onto `outDir`, refusing one that escapes it. */
function safeJoin(outDir: string, file: string): string {
  const target = resolve(outDir, file);
  if (isAbsolute(file) || (target !== outDir && !target.startsWith(outDir + sep))) {
    throw new Error(`generated file path "${file}" is outside ${outDir}`);
  }
  return target;
}

function displayPath(projectRoot: string, path: string): string {
  const rel = relative(projectRoot, path);
  return rel === "" ? "." : rel.split(sep).join("/");
}
