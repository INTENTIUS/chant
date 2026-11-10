/**
 * `@intentius/chant/generated-check` (#4909): the check that a product's
 * committed generated files are what their sources render.
 *
 * A product commits files that chant or its own scripts render from
 * TypeScript: workflows GitHub reads, Dockerfiles, a JSON Schema, a stack's
 * configs. Each product carried its own drift check for them: terragucci's
 * `just ci-check` rendered every one into a `mktemp -d` dir, compared it with
 * `diff -u` and cleaned up with `rm -rf`, and plywood's `build-images.mjs
 * --check` and `build-schema.mjs --check` compared in memory. Here a product
 * declares its renders in `chantGenerated` in its root package.json, and
 * `chant dev generated-check` runs them:
 *
 * 1. make one directory under the OS temp directory, the render tree;
 * 2. run every render's command in the product root at once, with `{out}`
 *    in the command and `CHANT_GENERATED_OUT` in its environment naming that
 *    tree, so each writes its files at their committed paths below it;
 * 3. compare each declared file with its render, in declaration order, and
 *    fail naming every file that differs, is missing on either side, or a
 *    render that failed.
 *
 * The render tree is never removed: it is left for the OS to clear, and the
 * check prints where it is, so a failure can be read there.
 *
 * chant's own writers read `CHANT_GENERATED_OUT` too ({@link renderPathOf},
 * {@link committedPathOf}): under a check, `chant ci workflow` and `chant
 * release workflow` write every file into the render tree, the trigger edits
 * to other workflows included, and name the committed path in their header,
 * so the render matches the file that was written without `--output`. #4950:
 * with no `--output` they write into the render tree too.
 *
 * A render can also be a module and its export (#4950, `./render-module`):
 * the check imports the module and writes the `{ path: text }` files the
 * export returns below the render tree, with no command or bundler.
 *
 * This module imports only Node's own modules; a module render loads
 * `./render-module` when it runs.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** The render tree of the running check, for chant's own writers and a product's scripts. */
export const GENERATED_OUT_ENV = "CHANT_GENERATED_OUT";
/** The product root the check renders for: the committed paths are relative to it. */
export const GENERATED_ROOT_ENV = "CHANT_GENERATED_ROOT";

/**
 * One render: a command that writes some of the product's generated files,
 * or (#4950) a module whose export returns them. Each render has `run`, or
 * `module` and `export`.
 */
export interface GeneratedRender {
  /** A short name, in the output: `ci`, `images`. */
  name: string;
  /**
   * A shell command run in the product root. `{out}` is the render tree,
   * quoted for the shell; the command writes each file at its committed path
   * below it (`npx chant build ci -o {out}/.github/workflows/ci.yml`).
   */
  run?: string;
  /**
   * #4950: a TypeScript or JavaScript module, relative to the product root,
   * whose {@link export} is a `{ path: text }` object, or a function that
   * returns one. chant imports it and writes each file at its path below the
   * render tree, as `chant dev render <module> <export>` writes it in place.
   */
  module?: string;
  /** The export of {@link module} that renders the files: `dockerfiles`. */
  export?: string;
  /**
   * The committed files it renders, relative to the product root. A `*` in a
   * path's last segment matches within it (`images/Dockerfile.*`), and then
   * every match on either side must have its twin. A command render with no
   * files passes when its command exits 0 (a script with a check of its
   * own); a module render with no files compares every file it renders.
   */
  files?: string[];
}

/** `chantGenerated` in a product's root package.json (#4909). */
export interface GeneratedCheckConfig {
  /** The command that writes the committed files, named in a failure: `just ci`. */
  regenerate?: string;
  renders: GeneratedRender[];
}

export interface GeneratedRenderResult {
  name: string;
  /** The command as run, `{out}` filled in. */
  command: string;
  exitCode: number;
  /** Its stdout and stderr, together. */
  output: string;
  /** The committed files compared, relative to the product root. */
  files: string[];
}

export interface GeneratedCheckResult {
  ok: boolean;
  /** The render tree, left in place. */
  out: string;
  problems: string[];
  renders: GeneratedRenderResult[];
  /** Each committed file that matched its render. */
  matched: string[];
}

/** The `chantGenerated` field of the package.json in `productDir`, or undefined. Throws on a malformed one. */
export function readGeneratedCheckConfig(productDir: string): GeneratedCheckConfig | undefined {
  const f = join(productDir, "package.json");
  if (!existsSync(f)) return undefined;
  const raw = (JSON.parse(readFileSync(f, "utf8")) as { chantGenerated?: unknown }).chantGenerated;
  if (raw === undefined) return undefined;
  const c = raw as Partial<GeneratedCheckConfig>;
  if (!c || typeof c !== "object" || !Array.isArray(c.renders)) throw new Error(`${f}: chantGenerated needs a renders list`);
  const names = new Set<string>();
  for (const [i, r] of c.renders.entries()) {
    if (!r || typeof r.name !== "string" || !r.name) throw new Error(`${f}: chantGenerated.renders[${i}] needs a name and a run command`);
    const isRun = r.run !== undefined;
    const isModule = r.module !== undefined || r.export !== undefined;
    if (isRun === isModule) throw new Error(`${f}: chantGenerated.renders[${i}] needs a run command, or a module and its export`);
    if (isRun && (typeof r.run !== "string" || !r.run)) throw new Error(`${f}: chantGenerated.renders[${i}] needs a name and a run command`);
    if (isModule && (typeof r.module !== "string" || !r.module || typeof r.export !== "string" || !r.export)) throw new Error(`${f}: chantGenerated.renders[${i}] needs a module and the name of its export`);
    if (isModule && (r.module!.startsWith("/") || r.module!.split("/").includes(".."))) throw new Error(`${f}: chantGenerated.renders[${i}].module must be a path inside the product`);
    if (names.has(r.name)) throw new Error(`${f}: chantGenerated.renders names '${r.name}' twice`);
    names.add(r.name);
    if (r.files !== undefined && (!Array.isArray(r.files) || r.files.some((p) => typeof p !== "string" || p.startsWith("/") || p.split("/").includes("..")))) {
      throw new Error(`${f}: chantGenerated.renders[${i}].files must be paths inside the product`);
    }
  }
  if (c.regenerate !== undefined && typeof c.regenerate !== "string") throw new Error(`${f}: chantGenerated.regenerate must be a command`);
  return c as GeneratedCheckConfig;
}

/** Quote one argument for `sh`. */
const shellQuote = (s: string) => (/^[A-Za-z0-9._\/=:@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The render tree and product root of the running check, or undefined outside one. */
function renderEnv(): { out: string; root: string } | undefined {
  const out = process.env[GENERATED_OUT_ENV];
  const root = process.env[GENERATED_ROOT_ENV];
  return out && root ? { out: resolve(out), root: resolve(root) } : undefined;
}

/** Whether `path` is `dir` or below it. */
const within = (dir: string, path: string) => {
  const r = relative(dir, resolve(path));
  return !r.startsWith("..") && !isAbsolute(r);
};

/**
 * Where a chant writer puts `path` (absolute): under a check, a path inside
 * the product root moves to the same place in the render tree, so a check
 * never writes the product's files. Outside a check, `path` itself.
 */
export function renderPathOf(path: string): string {
  const env = renderEnv();
  if (!env || within(env.out, path) || !within(env.root, path)) return path;
  return join(env.out, relative(env.root, path));
}

/** The committed path a render-tree path stands for, so a header names it; any other path is itself. */
export function committedPathOf(path: string): string {
  const env = renderEnv();
  if (!env || !within(env.out, path)) return path;
  return join(env.root, relative(env.out, path));
}

/** Whether `path` (absolute) is in the render tree of a running check. */
export function isRenderPath(path: string): boolean {
  const env = renderEnv();
  return env !== undefined && within(env.out, path);
}

/** The files a declared path names under `base`, relative to it: the path itself, or a last-segment `*` pattern's matches. */
function expand(base: string, path: string): string[] {
  const last = path.lastIndexOf("/");
  const dir = last < 0 ? "" : path.slice(0, last);
  const name = path.slice(last + 1);
  if (!name.includes("*")) return existsSync(join(base, path)) ? [path] : [];
  const re = new RegExp(`^${name.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
  const at = join(base, dir);
  if (!existsSync(at) || !statSync(at).isDirectory()) return [];
  return readdirSync(at)
    .filter((f) => re.test(f) && statSync(join(at, f)).isFile())
    .sort()
    .map((f) => (dir ? `${dir}/${f}` : f));
}

/** A short line diff of two texts: the first lines that differ, with a little context. */
export function diffLines(committed: string, rendered: string, max = 12): string[] {
  const a = committed.split("\n");
  const b = rendered.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out = [`@@ line ${start + 1} @@`];
  for (const l of a.slice(Math.max(0, start - 2), start)) out.push(`  ${l}`);
  const removed = a.slice(start, endA).map((l) => `- ${l}`);
  const added = b.slice(start, endB).map((l) => `+ ${l}`);
  const body = [...removed, ...added];
  out.push(...body.slice(0, max));
  if (body.length > max) out.push(`  ... ${body.length - max} more changed lines`);
  return out;
}

/** Run one render; resolves with its exit code and output. */
function runRender(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ exitCode: number; output: string }> {
  return new Promise((done) => {
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err) => done({ exitCode: 127, output: String(err) }));
    child.on("close", (code, signal) => done({ exitCode: code ?? (signal ? 128 : 1), output: Buffer.concat(chunks).toString("utf8") }));
  });
}

export interface GeneratedCheckOptions {
  /** Only these renders, by name. */
  only?: string[];
  /** The render tree's parent directory (default: the OS temp directory). */
  tmpDir?: string;
}

/**
 * Render the product's declared generated files into a fresh directory under
 * the OS temp directory and compare each with the committed file (#4909).
 * The directory is left in place and named in the result.
 */
export async function checkGenerated(productDir: string, config: GeneratedCheckConfig, opts: GeneratedCheckOptions = {}): Promise<GeneratedCheckResult> {
  const root = realpathSync(resolve(productDir));
  const out = realpathSync(mkdtempSync(join(opts.tmpDir ?? tmpdir(), "chant-generated-")));
  const problems: string[] = [];
  let renders = config.renders;
  if (opts.only?.length) {
    const unknown = opts.only.filter((n) => !renders.some((r) => r.name === n));
    if (unknown.length) problems.push(`chantGenerated has no render named ${unknown.map((n) => `'${n}'`).join(", ")}`);
    renders = renders.filter((r) => opts.only!.includes(r.name));
  }
  const env = { ...process.env, [GENERATED_OUT_ENV]: out, [GENERATED_ROOT_ENV]: root };
  const ran = await Promise.all(
    renders.map(async (r) => {
      if (r.module !== undefined) {
        // #4950: a module render runs here, in chant's process, with the
        // TypeScript loader and chant served as itself. Exit 1 and the error
        // stand in for a command's exit code and output.
        const command = `chant dev render ${shellQuote(r.module)} ${shellQuote(r.export!)}`;
        try {
          const { renderModuleFiles, writeRenderedFiles } = await import("./render-module");
          const rendered = await renderModuleFiles(r.module, r.export!, root);
          writeRenderedFiles(out, rendered);
          return { r, command, exitCode: 0, output: "", rendered: Object.keys(rendered) };
        } catch (err) {
          return { r, command, exitCode: 1, output: err instanceof Error ? err.message : String(err) };
        }
      }
      const command = r.run!.split("{out}").join(shellQuote(out));
      return { r, command, ...(await runRender(command, root, env)) };
    }),
  );

  const results: GeneratedRenderResult[] = [];
  const matched: string[] = [];
  const hint = config.regenerate ? ` Run '${config.regenerate}' and commit the result.` : "";
  for (const { r, command, exitCode, output, rendered } of ran as ((typeof ran)[number] & { rendered?: string[] })[]) {
    const files: string[] = [];
    results.push({ name: r.name, command, exitCode, output, files });
    if (exitCode !== 0) {
      problems.push(`render '${r.name}' exited ${exitCode}: ${command}${output.trim() ? `\n${output.trimEnd().split("\n").map((l) => `    ${l}`).join("\n")}` : ""}`);
      continue;
    }
    // A module render with no files compares every file it rendered.
    for (const path of r.files ?? rendered ?? []) {
      const committed = expand(root, path);
      const rendered = expand(out, path);
      if (!path.includes("*") && rendered.length === 0) {
        problems.push(`render '${r.name}' wrote no ${path} under the render tree`);
        continue;
      }
      if (path.includes("*") && committed.length === 0 && rendered.length === 0) {
        problems.push(`${path} matches no file, committed or rendered by '${r.name}'`);
        continue;
      }
      for (const f of [...new Set([...committed, ...rendered])].sort()) {
        files.push(f);
        if (!rendered.includes(f)) {
          problems.push(`${f} is committed, but '${r.name}' no longer renders it.${hint}`);
          continue;
        }
        if (!committed.includes(f)) {
          problems.push(`${f} is what '${r.name}' renders, but it is not committed.${hint}`);
          continue;
        }
        const a = readFileSync(join(root, f), "utf8");
        const b = readFileSync(join(out, f), "utf8");
        if (a === b) matched.push(f);
        else problems.push(`${f} is not what '${r.name}' renders.${hint}\n${diffLines(a, b).map((l) => `    ${l}`).join("\n")}`);
      }
    }
  }
  return { ok: problems.length === 0, out, problems, renders: results, matched };
}
