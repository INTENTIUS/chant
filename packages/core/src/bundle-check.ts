/**
 * `@intentius/chant/bundle-check` (#4787): how a product's bundle treats its
 * chant imports, and the check that holds the bundle to that shape.
 *
 * A product (terragucci, plywood, sql-yodeler) bundles its own code into one
 * file and imports chant from the installed, pinned package at run time,
 * wherever that package serves the import as compiled JS under Node's
 * `import` condition (#4591). Each product carried its own copy of this:
 * `chantRuntimeTarget` and an esbuild plugin that leaves such imports
 * external, and a bundle check that the bundle imports nothing else, that the
 * package's runtime dependencies match the root's chant pin, and that the
 * bundle stays under its size ceiling. They live here so a product only
 * names its bundle, its ceiling and its denied inputs (`chantBundleCheck` in
 * the package's package.json, read by `chant dev bundle-check`).
 *
 * This module imports only Node's own modules, so a product's build script
 * can import it from plain Node.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";

/** Any `@intentius/chant` package, with or without a subpath: core and every lexicon. */
const CHANT = /^(@intentius\/chant(?:-[a-z0-9-]+)?)(\/.*)?$/;
const CONDITIONS = ["import", "node", "default"];

/** The target Node's ESM conditions pick from one exports value, in key order. */
function pick(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = pick(v);
      if (t !== undefined) return t;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (CONDITIONS.includes(key)) return pick(v);
    }
  }
  return undefined;
}

/** The file `subpath` (`.` or `./x`) of the package at `pkgDir` names under Node's ESM conditions, or undefined. */
function exportsTarget(pkgDir: string, subpath: string): string | undefined {
  const map = (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { exports?: unknown }).exports;
  if (typeof map === "string") return subpath === "." ? join(pkgDir, map) : undefined;
  if (!map || typeof map !== "object" || Array.isArray(map)) return undefined;
  const entries = map as Record<string, unknown>;
  // A map of conditions alone is the root's entry.
  if (!Object.keys(entries).some((k) => k.startsWith("."))) {
    const t = subpath === "." ? pick(entries) : undefined;
    return t === undefined ? undefined : join(pkgDir, t);
  }
  if (subpath in entries) {
    const t = pick(entries[subpath]);
    return t === undefined ? undefined : join(pkgDir, t);
  }
  // Node's pattern match: of the keys with one `*` that match, the longest prefix wins.
  let best: { prefix: string; star: string; value: unknown } | undefined;
  for (const key of Object.keys(entries)) {
    const at = key.indexOf("*");
    if (at < 0 || key.indexOf("*", at + 1) >= 0) continue;
    const prefix = key.slice(0, at);
    const suffix = key.slice(at + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < key.length - 1) continue;
    if (best && prefix.length <= best.prefix.length) continue;
    best = { prefix, star: subpath.slice(prefix.length, subpath.length - suffix.length), value: entries[key] };
  }
  if (!best) return undefined;
  const t = pick(best.value);
  return t === undefined ? undefined : join(pkgDir, t.split("*").join(best.star));
}

/** The directory of `name` as Node finds it from `fromDir`, walking up the node_modules folders, or undefined. */
export function installedPackageDir(name: string, fromDir: string): string | undefined {
  for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
    const pkgDir = join(dir, "node_modules", name);
    if (existsSync(join(pkgDir, "package.json"))) return pkgDir;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * The compiled file Node would load for the chant `specifier` (core or a
 * lexicon, with or without a subpath) imported from a file in `fromDir`, or
 * undefined: the specifier is not chant's, the installed package does not
 * export it, exports only TypeScript for it, or is not installed. Plain Node
 * does not load TypeScript from node_modules, so only a compiled target can
 * stay external.
 */
export function chantRuntimeTarget(specifier: string, fromDir: string): string | undefined {
  const m = CHANT.exec(specifier);
  if (!m) return undefined;
  const pkgDir = installedPackageDir(m[1], fromDir);
  if (pkgDir === undefined) return undefined;
  const file = exportsTarget(pkgDir, m[2] ? `.${m[2]}` : ".");
  return file !== undefined && /\.(?:m?js|cjs)$/.test(file) && existsSync(file) ? file : undefined;
}

/** Whether the chant installed for the package at `pkgDir` serves its root as compiled JS (#4591 and later). */
export function chantServesCompiled(pkgDir: string): boolean {
  return chantRuntimeTarget("@intentius/chant", pkgDir) !== undefined;
}

/** The part of esbuild's plugin API {@link chantExternalPlugin} uses, so this module needs no esbuild types. */
export interface EsbuildPluginLike {
  name: string;
  setup(build: {
    onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; external: boolean } | undefined): void;
  }): void;
}

/**
 * An esbuild plugin that leaves an `@intentius/chant*` import external when
 * the chant installed for `pkgDir` (where the bin runs) serves it as compiled
 * JS, so the bundle runs the installed, pinned chant. Any other chant import
 * goes on to the next plugin and esbuild, which bundle it. `external`, when
 * given, collects the specifiers left external.
 */
export function chantExternalPlugin(pkgDir: string, external?: Set<string>): EsbuildPluginLike {
  return {
    name: "chant-external",
    setup(b) {
      b.onResolve({ filter: CHANT }, (args) => {
        if (chantRuntimeTarget(args.path, pkgDir) === undefined) return undefined;
        external?.add(args.path);
        return { path: args.path, external: true };
      });
    },
  };
}

/**
 * The bare specifiers a bundle imports: static `import` and `export ... from`,
 * `import()` and `require()` of a string. Relative imports are left out, and
 * so are strings in minified code that the pattern also matches but that hold
 * spaces, commas, quotes or template braces.
 */
export function bundleImports(text: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[;\s}])(?:import|export)\s*(?:[\w*{}\s,$]+from\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/gm;
  for (const m of text.matchAll(re)) {
    const s = m[1] ?? m[2] ?? m[3];
    if (s !== undefined && /^[\w@][\w@./:-]*$/.test(s)) out.add(s);
  }
  return [...out];
}

/** The package a bare specifier names: `@scope/name` or `name`. */
export function packageOf(specifier: string): string {
  return specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
}

/** An input the bundle must not include: a pattern matched against each metafile input with everything up to its last `node_modules/` removed. */
export interface DeniedInput {
  pattern: string;
  /** What the input is, in the failure: "the TypeScript compiler". */
  what: string;
}

/** A product's bundle check, as `chantBundleCheck` in its package's package.json (#4787). Paths are relative to the package. */
export interface BundleCheckConfig {
  /** The bundle file, such as `dist/terragucci.mjs`. */
  bundle: string;
  /** The most bytes the bundle file may hold. */
  maxBytes?: number;
  /** The most bytes the package's `npm pack` tarball may hold (`npm pack --dry-run --ignore-scripts`). */
  maxPackBytes?: number;
  /**
   * Packages the code loads at run time that no import in the bundle names,
   * such as `@intentius/chant` for a bin it spawns, or a lexicon chant's
   * generator loads by name. Each must be a runtime dependency.
   */
  needs?: string[];
  /** Packages the bundle may import that are not dependencies: optional ones it loads when present. */
  optional?: string[];
  /** esbuild's metafile for the bundle, to check its inputs against `deny`. */
  metafile?: string;
  deny?: DeniedInput[];
}

export interface BundleCheckResult {
  ok: boolean;
  problems: string[];
  /** One line saying what was checked, for a passing check. */
  summary: string;
  bundleBytes: number;
  packBytes?: number;
  /** The chant imports the bundle leaves to the installed chant. */
  chantImports: string[];
  /** The installed chant's version, with the commit when it is a local build (`chantLocal`). */
  chant: string;
}

interface Manifest {
  name?: string;
  version?: string;
  workspaces?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  chantBundleCheck?: BundleCheckConfig;
  chantLocal?: { commit?: string; dir?: string };
}

const readManifest = (file: string): Manifest => JSON.parse(readFileSync(file, "utf8")) as Manifest;

/** The nearest directory from `pkgDir` up whose package.json declares workspaces, else `pkgDir`: where the product pins chant. */
export function productRoot(pkgDir: string): string {
  for (let dir = resolve(pkgDir); ; dir = dirname(dir)) {
    const f = join(dir, "package.json");
    if (existsSync(f) && readManifest(f).workspaces !== undefined) return dir;
    if (dirname(dir) === dir) return resolve(pkgDir);
  }
}

/** The `chantBundleCheck` field of the package at `pkgDir`, or undefined when it has none. */
export function readBundleCheckConfig(pkgDir: string): BundleCheckConfig | undefined {
  const f = join(pkgDir, "package.json");
  if (!existsSync(f)) return undefined;
  return readManifest(f).chantBundleCheck;
}

/** The size of the tarball `npm pack` would write for the package at `pkgDir`, without running its scripts. */
function packSize(pkgDir: string): number {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: pkgDir, stdio: ["ignore", "pipe", "pipe"] }).toString();
  const [packed] = JSON.parse(out) as { size: number }[];
  return packed.size;
}

/**
 * Check the package at `pkgDir` against `config` (#4787):
 *
 * - the bundle imports only Node's modules, its runtime dependencies and the
 *   `optional` packages, and each chant import is one the installed chant
 *   serves as compiled JS ({@link chantRuntimeTarget});
 * - the runtime dependencies are exactly the packages the bundle imports and
 *   the `needs`, and every `@intentius/chant*` among them and among the
 *   devDependencies is pinned to the root's `@intentius/chant`, an exact version;
 * - each installed chant package is that version, or a local build marked
 *   `chantLocal` (`chant dev local`);
 * - the bundle and the tarball stay within `maxBytes` and `maxPackBytes`;
 * - no metafile input matches a `deny` pattern.
 */
export function checkBundle(pkgDir: string, config: BundleCheckConfig): BundleCheckResult {
  const dir = resolve(pkgDir);
  const problems: string[] = [];
  const pkg = readManifest(join(dir, "package.json"));
  const root = productRoot(dir);
  const rootPkg = readManifest(join(root, "package.json"));
  const pin = rootPkg.dependencies?.["@intentius/chant"] ?? rootPkg.devDependencies?.["@intentius/chant"];
  if (pin === undefined) problems.push(`${join(root, "package.json")} does not name @intentius/chant`);
  else if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(pin)) problems.push(`@intentius/chant is '${pin}' in ${join(root, "package.json")}, not an exact version`);

  const bundleFile = join(dir, config.bundle);
  let text = "";
  let bundleBytes = 0;
  if (!existsSync(bundleFile)) problems.push(`no bundle at ${config.bundle}; build it first`);
  else {
    text = readFileSync(bundleFile, "utf8");
    bundleBytes = statSync(bundleFile).size;
    if (config.maxBytes !== undefined && bundleBytes > config.maxBytes) {
      problems.push(`the bundle is ${Math.round(bundleBytes / 1024)} KB, over the ${Math.round(config.maxBytes / 1024)} KB ceiling`);
    }
  }

  const deps = pkg.dependencies ?? {};
  const optional = new Set(config.optional ?? []);
  const node = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  const used = new Map<string, string>();
  for (const n of config.needs ?? []) used.set(n, "chantBundleCheck.needs names it");
  const chantImports: string[] = [];
  for (const s of bundleImports(text)) {
    if (node.has(s) || optional.has(s) || optional.has(packageOf(s))) continue;
    const name = packageOf(s);
    if (!(name in deps)) {
      problems.push(`the bundle imports '${s}', which is neither a Node module nor a runtime dependency`);
      continue;
    }
    if (!used.has(name)) used.set(name, `the bundle imports ${s}`);
    if (CHANT.test(s)) {
      if (chantRuntimeTarget(s, dir) === undefined) problems.push(`the bundle imports '${s}', which the installed package's exports do not serve as compiled JS under the import condition`);
      else chantImports.push(s);
    }
  }
  for (const [name, why] of used) {
    if (!(name in deps)) problems.push(`${name} is loaded at run time (${why}) but is not in dependencies${name in (pkg.devDependencies ?? {}) ? " (it is a devDependency, which npm install --omit=dev leaves out)" : ""}`);
  }
  for (const name of Object.keys(deps)) {
    if (!used.has(name)) problems.push(`${name} is a runtime dependency that the bundle does not import and chantBundleCheck.needs does not name`);
  }
  if (pin !== undefined) {
    for (const [kind, list] of [["dependencies", deps], ["devDependencies", pkg.devDependencies ?? {}]] as const) {
      if (dir === root && kind === "devDependencies") continue;
      for (const [name, v] of Object.entries(list)) {
        if (CHANT.test(name) && v !== pin) problems.push(`${name} is '${v}' in ${kind}, not the root's chant pin ${pin}`);
      }
    }
  }

  // The installed copies: the pin, or a local build `chant dev local` marked.
  let chant = "not installed";
  const coreDir = installedPackageDir("@intentius/chant", dir);
  if (coreDir === undefined) problems.push("@intentius/chant is not installed; run npm ci");
  else {
    const core = readManifest(join(coreDir, "package.json"));
    chant = core.chantLocal ? `local chant ${core.version} (${String(core.chantLocal.commit).slice(0, 12)})` : `chant ${core.version}`;
  }
  for (const name of new Set([...Object.keys(deps), ...Object.keys(pkg.devDependencies ?? {})])) {
    if (!CHANT.test(name) || pin === undefined) continue;
    const at = installedPackageDir(name, dir);
    if (at === undefined) {
      if (name in deps) problems.push(`${name} is not installed; run npm ci`);
      continue;
    }
    const installed = readManifest(join(at, "package.json"));
    if (!installed.chantLocal && installed.version !== pin) problems.push(`the installed ${name} is ${installed.version}, not the pin ${pin}; run npm ci`);
  }

  if (config.deny?.length) {
    const metafile = config.metafile === undefined ? undefined : join(dir, config.metafile);
    if (metafile === undefined || !existsSync(metafile)) problems.push(`chantBundleCheck.deny needs the build's esbuild metafile${config.metafile ? ` at ${config.metafile}` : " (chantBundleCheck.metafile)"}`);
    else {
      const inputs = Object.keys((JSON.parse(readFileSync(metafile, "utf8")) as { inputs?: Record<string, unknown> }).inputs ?? {});
      const rules = config.deny.map((d) => ({ re: new RegExp(d.pattern), what: d.what }));
      const hits = new Map<string, string[]>();
      for (const input of inputs) {
        const rel = input.replace(/^.*node_modules\//, "");
        for (const r of rules) if (r.re.test(rel)) hits.set(r.what, [...(hits.get(r.what) ?? []), rel]);
      }
      for (const [what, list] of hits) {
        problems.push(`the bundle includes ${what} (${list.length} inputs): ${list.slice(0, 3).join(", ")}${list.length > 3 ? `, and ${list.length - 3} more` : ""}`);
      }
    }
  }

  let packBytes: number | undefined;
  if (config.maxPackBytes !== undefined) {
    packBytes = packSize(dir);
    if (packBytes > config.maxPackBytes) problems.push(`the tarball is ${Math.round(packBytes / 1024)} KB, over the ${Math.round(config.maxPackBytes / 1024)} KB ceiling`);
  }

  const sizes = [
    `bundle ${Math.round(bundleBytes / 1024)} KB${config.maxBytes !== undefined ? ` (ceiling ${Math.round(config.maxBytes / 1024)} KB)` : ""}`,
    ...(packBytes !== undefined ? [`tarball ${Math.round(packBytes / 1024)} KB (ceiling ${Math.round(config.maxPackBytes! / 1024)} KB)`] : []),
  ];
  const summary = `${pkg.name ?? dir}: ${sizes.join(", ")}, ${Object.keys(deps).length} runtime dependencies at chant ${pin}, ${chantImports.length} chant imports served as compiled JS by ${chant}`;
  return { ok: problems.length === 0, problems, summary, bundleBytes, packBytes, chantImports, chant };
}

