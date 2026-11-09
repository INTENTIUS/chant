/**
 * `@intentius/chant/local-chant` (#4787): build a product against a chant
 * checkout instead of its pinned release.
 *
 * terragucci and plywood each carried a 270-line `scripts/chant-local.sh`
 * that did this, and sql-yodeler would have copied it. `chant dev local`
 * runs these functions:
 *
 * 1. find the chant packages the product's package.json files name (and any
 *    `with`), plus the chant packages those depend on, in an order where each
 *    follows the packages it builds against ({@link packOrder});
 * 2. `npm ci` in the checkout when its lock changed since the last run, then
 *    `npm pack` each package (its prepack builds it) into `.chant-local/` in
 *    the product, under a fixed name per package;
 * 3. point every package.json of the product at the tarballs, run
 *    `npm install --no-save`, and put the manifests and package-lock.json
 *    back byte for byte, so the workspace gets the local build everywhere and
 *    git sees no change;
 * 4. mark each installed copy's package.json with `chantLocal` (the commit and
 *    the checkout), which `checkBundle` and a reader use to tell the local
 *    build from the pin, and fail when a copy is not the local build.
 *
 * {@link resetLocalChant} goes back: `npm ci`, then a check that every
 * installed chant package is the version the lock pins, with no mark.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** A chant workspace package that can be packed: not private. */
export interface ChantPackage {
  name: string;
  version: string;
  /** Relative to the checkout: `packages/core`, `lexicons/k8s`. */
  dir: string;
  /** Its dependencies, peer and optional dependencies, by name. */
  deps: string[];
}

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  chantLocal?: LocalChantMark;
}

/** The `chantLocal` field `chant dev local` writes into each installed copy's package.json. */
export interface LocalChantMark {
  /** The checkout's commit, with `+dirty` when tracked files had changes. */
  commit: string;
  /** The checkout. */
  dir: string;
}

export class LocalChantError extends Error {
  override name = "LocalChantError";
}

const readManifest = (file: string): Manifest => JSON.parse(readFileSync(file, "utf8")) as Manifest;
const isChant = (name: string) => /^@intentius\/chant(?:-[a-z0-9-]+)?$/.test(name);

/** The packable packages of a chant checkout, under `packages/` and `lexicons/`, by name. */
export function chantPackages(chantDir: string): Map<string, ChantPackage> {
  const out = new Map<string, ChantPackage>();
  for (const top of ["packages", "lexicons"]) {
    const base = join(chantDir, top);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base).sort()) {
      const f = join(base, d, "package.json");
      if (!existsSync(f)) continue;
      const p = readManifest(f);
      if (p.private || !p.name) continue;
      out.set(p.name, {
        name: p.name,
        version: p.version ?? "0.0.0",
        dir: `${top}/${d}`,
        deps: Object.keys({ ...p.dependencies, ...p.peerDependencies, ...p.optionalDependencies }),
      });
    }
  }
  return out;
}

/** The product's package.json files, relative to its root: the root's and each workspace package's. */
export function productManifests(productDir: string): string[] {
  const root = readManifest(join(productDir, "package.json"));
  const patterns = Array.isArray(root.workspaces) ? root.workspaces : (root.workspaces?.packages ?? []);
  const out = ["package.json"];
  for (const pattern of patterns) {
    const clean = pattern.replace(/\/+$/, "");
    const dirs = clean.endsWith("/*")
      ? (existsSync(join(productDir, clean.slice(0, -2))) ? readdirSync(join(productDir, clean.slice(0, -2))).sort().map((d) => `${clean.slice(0, -2)}/${d}`) : [])
      : [clean];
    for (const d of dirs) if (existsSync(join(productDir, d, "package.json"))) out.push(`${d}/package.json`);
  }
  return [...new Set(out)];
}

/** Every `@intentius/chant*` the product's package.json files name in dependencies, devDependencies or peerDependencies. */
export function productChantNames(productDir: string): string[] {
  const out = new Set<string>();
  for (const f of productManifests(productDir)) {
    const p = readManifest(join(productDir, f));
    for (const n of Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.peerDependencies })) if (isChant(n)) out.add(n);
  }
  return [...out].sort();
}

/**
 * The packages to pack for `want` and their chant dependencies, each after
 * the packages it depends on, ties by name. Throws on a name the checkout has
 * no package for, and on a cycle.
 */
export function packOrder(pkgs: Map<string, ChantPackage>, want: Iterable<string>): ChantPackage[] {
  const need = new Set<string>();
  const visit = (n: string) => {
    if (need.has(n)) return;
    const p = pkgs.get(n);
    if (!p) throw new LocalChantError(`the chant checkout has no package ${n}`);
    need.add(n);
    for (const d of p.deps) if (pkgs.has(d)) visit(d);
  };
  for (const n of want) visit(n);
  const out: ChantPackage[] = [];
  const left = new Set(need);
  while (left.size) {
    const ready = [...left].filter((n) => !pkgs.get(n)!.deps.some((d) => d !== n && left.has(d))).sort();
    if (!ready.length) throw new LocalChantError(`dependency cycle among ${[...left].sort().join(", ")}`);
    for (const n of ready) {
      out.push(pkgs.get(n)!);
      left.delete(n);
    }
  }
  return out;
}

/** The fixed tarball name for a package, so a later run replaces it: `@intentius/chant-lexicon-k8s` is `intentius-chant-lexicon-k8s.tgz`. */
export const tarballName = (name: string) => `${name.replace(/^@/, "").replace(/\//g, "-")}.tgz`;

/**
 * One package.json pointed at the tarballs: every dependency, devDependency
 * and optionalDependency `local` names takes its `file:` spec. The root also
 * gets every tarball as a devDependency, so npm replaces a copy only a lexicon
 * reaches (a lexicon's own chant dependencies) instead of keeping a registry
 * release of it.
 */
export function pointAtTarballs(manifest: Manifest, local: Map<string, string>, isRoot: boolean): Manifest {
  const p: Manifest = structuredClone(manifest);
  for (const k of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const deps = p[k];
    if (!deps) continue;
    for (const n of Object.keys(deps)) if (local.has(n)) deps[n] = local.get(n)!;
  }
  if (isRoot) {
    const extra = Object.fromEntries([...local].filter(([n]) => !(n in (p.dependencies ?? {})) && !(n in (p.optionalDependencies ?? {}))));
    p.devDependencies = { ...p.devDependencies, ...extra };
  }
  return p;
}

/** Each installed copy of a chant package under the product: `node_modules/@intentius/*` at the root, in each workspace package, and nested. Links (workspace packages) are left out. */
export function installedChantCopies(productDir: string): { at: string; name: string }[] {
  const out: { at: string; name: string }[] = [];
  const walk = (nm: string) => {
    const scope = join(nm, "@intentius");
    if (!existsSync(scope)) return;
    for (const d of readdirSync(scope).sort()) {
      const at = join(scope, d);
      if (lstatSync(at).isSymbolicLink() || !existsSync(join(at, "package.json"))) continue;
      walk(join(at, "node_modules"));
      const name = `@intentius/${d}`;
      if (isChant(name)) out.push({ at, name });
    }
  };
  walk(join(productDir, "node_modules"));
  for (const f of productManifests(productDir).slice(1)) walk(join(productDir, f.replace(/package\.json$/, ""), "node_modules"));
  return out;
}

/** How a command runs: throws {@link LocalChantError} when it exits non-zero. */
export type Runner = (command: string, args: string[], cwd: string) => string;

/** Run a command with its stderr on ours and its stdout returned. */
export const defaultRunner: Runner = (command, args, cwd) => {
  const r = spawnSync(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new LocalChantError(`${command} ${args.join(" ")} in ${cwd}: ${r.error.message}`);
  if (r.status !== 0) throw new LocalChantError(`${command} ${args.join(" ")} in ${cwd} exited ${r.status ?? r.signal}`);
  return r.stdout;
};

export interface LocalChantOptions {
  /** The product's root, where its package.json and lock are. */
  productDir: string;
  /** The chant checkout to pack. */
  chantDir: string;
  /** Chant packages to pack besides the ones the product names, such as a lexicon an image installs. */
  with?: string[];
  /** Run `npm ci` in the checkout when its lock changed since the last run (default true). */
  install?: boolean;
  log?: (line: string) => void;
  run?: Runner;
}

export interface LocalChantResult {
  mark: LocalChantMark;
  /** What was packed, in pack order, with each tarball's path. */
  packed: (ChantPackage & { tarball: string })[];
  /** How many installed copies were marked. */
  marked: number;
  /** The tarball directory, `<product>/.chant-local`. */
  outDir: string;
}

/** The checkout's commit, with `+dirty` when tracked files have changes; `unknown` outside git. */
function checkoutMark(chantDir: string): string {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: chantDir, encoding: "utf8" });
  if (head.status !== 0) return "unknown";
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: chantDir, encoding: "utf8" });
  return `${head.stdout.trim()}${status.stdout.trim() ? "+dirty" : ""}`;
}

/** Pack the chant checkout and install it into the product, leaving its package.json files and lock as they were. */
export function installLocalChant(opts: LocalChantOptions): LocalChantResult {
  const productDir = resolve(opts.productDir);
  const chantDir = resolve(opts.chantDir);
  const log = opts.log ?? ((l: string) => process.stderr.write(`chant dev local: ${l}\n`));
  const run = opts.run ?? defaultRunner;
  if (!existsSync(join(productDir, "package.json"))) throw new LocalChantError(`${productDir} has no package.json`);
  if (!existsSync(join(chantDir, "packages/core/package.json"))) throw new LocalChantError(`${chantDir} is not a chant checkout (no packages/core/package.json)`);

  const mark: LocalChantMark = { commit: checkoutMark(chantDir), dir: chantDir };
  log(`chant at ${mark.commit} (${chantDir})`);

  if (opts.install !== false) {
    const lock = join(chantDir, "package-lock.json");
    if (!existsSync(lock)) throw new LocalChantError(`${chantDir} has no package-lock.json to npm ci from`);
    const sum = createHash("sha256").update(readFileSync(lock)).digest("hex");
    const stamp = join(chantDir, "node_modules/.chant-dev-local");
    if (!existsSync(stamp) || readFileSync(stamp, "utf8").trim() !== sum) {
      log("npm ci in the chant checkout");
      run("npm", ["ci", "--no-audit", "--no-fund"], chantDir);
      writeFileSync(stamp, `${sum}\n`);
    }
  }

  const pkgs = chantPackages(chantDir);
  const order = packOrder(pkgs, [...productChantNames(productDir), ...(opts.with ?? [])]);
  if (!order.length) throw new LocalChantError(`${productDir}'s package.json files name no @intentius/chant package`);

  const outDir = join(productDir, ".chant-local");
  mkdirSync(join(outDir, "manifests"), { recursive: true });
  const packed: LocalChantResult["packed"] = [];
  for (const p of order) {
    log(`packing ${p.dir}`);
    const out = run("npm", ["pack", "--silent", "--pack-destination", outDir], join(chantDir, p.dir));
    const file = out.trim().split("\n").pop()?.trim() ?? "";
    if (!file || !existsSync(join(outDir, file))) throw new LocalChantError(`npm pack in ${p.dir} wrote no tarball`);
    const fixed = tarballName(p.name);
    if (file !== fixed) renameSync(join(outDir, file), join(outDir, fixed));
    packed.push({ ...p, tarball: join(outDir, fixed) });
  }
  writeFileSync(join(outDir, "commit"), `${mark.commit}\n`);
  writeFileSync(join(outDir, "packages.json"), `${JSON.stringify(packed.map((p) => ({ name: p.name, version: p.version, tarball: relative(productDir, p.tarball) })), null, 2)}\n`);

  // The workspace packages pin chant too, so installing at the root alone
  // would leave the pinned copies nested under packages/*/node_modules. Point
  // every package.json at the tarballs for one install and put each file
  // back afterwards, the lock with them. --legacy-peer-deps because the pinned
  // lexicons still in the tree want the pinned core as a peer until npm
  // replaces them.
  const local = new Map(packed.map((p) => [p.name, `file:${p.tarball}`]));
  const files = [...productManifests(productDir), ...(existsSync(join(productDir, "package-lock.json")) ? ["package-lock.json"] : [])];
  const saved = new Map(files.map((f) => [f, readFileSync(join(productDir, f))]));
  for (const [f, body] of saved) writeFileSync(join(outDir, "manifests", f.replace(/\//g, "_")), body);
  try {
    for (const f of files) {
      if (!f.endsWith("package.json")) continue;
      const p = pointAtTarballs(JSON.parse(saved.get(f)!.toString("utf8")) as Manifest, local, f === "package.json");
      writeFileSync(join(productDir, f), `${JSON.stringify(p, null, 2)}\n`);
    }
    log(`installing ${packed.length} tarballs with npm install --no-save`);
    run("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--legacy-peer-deps"], productDir);
  } finally {
    for (const [f, body] of saved) writeFileSync(join(productDir, f), body);
  }

  const versions = new Map(packed.map((p) => [p.name, p.version]));
  const bad: string[] = [];
  let marked = 0;
  for (const { at, name } of installedChantCopies(productDir)) {
    if (!versions.has(name)) continue;
    const f = join(at, "package.json");
    const p = readManifest(f);
    if (p.version !== versions.get(name)) {
      bad.push(`${relative(productDir, at)} is ${p.version}, the checkout's is ${versions.get(name)}`);
      continue;
    }
    p.chantLocal = mark;
    writeFileSync(f, `${JSON.stringify(p, null, 2)}\n`);
    marked++;
  }
  if (bad.length) throw new LocalChantError(`these installed copies are not the local build:\n  ${bad.join("\n  ")}`);
  log(`marked ${marked} installed chant packages with ${mark.commit}`);
  return { mark, packed, marked, outDir };
}

/** The installed chant copies that differ from what package-lock.json pins, or carry a `chantLocal` mark. */
export function lockMismatches(productDir: string): string[] {
  const dir = resolve(productDir);
  const lockFile = join(dir, "package-lock.json");
  if (!existsSync(lockFile)) return ["there is no package-lock.json"];
  const lock = (JSON.parse(readFileSync(lockFile, "utf8")) as { packages?: Record<string, { version?: string; link?: boolean }> }).packages ?? {};
  const bad: string[] = [];
  for (const [at, entry] of Object.entries(lock)) {
    if (!/(^|\/)node_modules\/@intentius\/chant[^/]*$/.test(at) || entry.link) continue;
    const f = join(dir, at, "package.json");
    if (!existsSync(f)) {
      bad.push(`${at} is missing`);
      continue;
    }
    const p = readManifest(f);
    if (p.version !== entry.version || p.chantLocal) bad.push(`${at} is ${p.version}${p.chantLocal ? " (local build)" : ""}, the lock says ${entry.version}`);
  }
  return bad;
}

/** Go back to the pin: `npm ci`, then fail when an installed chant package is not what the lock pins. */
export function resetLocalChant(opts: { productDir: string; log?: (line: string) => void; run?: Runner }): void {
  const dir = resolve(opts.productDir);
  const log = opts.log ?? ((l: string) => process.stderr.write(`chant dev local: ${l}\n`));
  log("reinstalling the pinned versions with npm ci");
  (opts.run ?? defaultRunner)("npm", ["ci", "--no-audit", "--no-fund"], dir);
  const bad = lockMismatches(dir);
  if (bad.length) throw new LocalChantError(`node_modules does not match package-lock.json after npm ci:\n  ${bad.join("\n  ")}`);
}
