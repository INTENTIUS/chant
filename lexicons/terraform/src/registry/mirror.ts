/**
 * A provider network mirror served from the module registry's bucket
 * (chant#4564), and the lock-file grouping terragucci's image recipe uses for
 * its `filesystem_mirror` (moved from terragucci `image-recipe.ts:225-232`,
 * 18f6431595), so both build from one implementation.
 *
 * The network mirror protocol is the layout `providers mirror` writes, served
 * over HTTPS (https://developer.hashicorp.com/terraform/internals/provider-network-mirror-protocol):
 *
 *   <host>/<namespace>/<type>/index.json        {"versions": {"<v>": {}}}
 *   <host>/<namespace>/<type>/<v>.json          {"archives": {"<os>_<arch>": {"url": ..., "hashes": ["h1:...", "zh:..."]}}}
 *   <host>/<namespace>/<type>/terraform-provider-<type>_<v>_<os>_<arch>.zip
 *
 * `buildMirror` writes one module per distinct lock file, each holding its
 * providers at exactly the locked version beside that lock file, and runs
 * `providers mirror` on each for the platforms asked for, so the lock file's
 * hashes check every download. `uploadMirror` puts the result under the
 * registry's prefix at `providers/`, archives first and `index.json` last, and
 * merges each `index.json` with the one already in the bucket.
 *
 * Lock files keep the host the provider came from. A hostless source resolves
 * to registry.terraform.io under Terraform and to registry.opentofu.org under
 * OpenTofu and choudoufu, so by default each provider locked on one of those
 * two hosts is mirrored under the other as well.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative } from "node:path";
import { keyFor } from "./address";
import { PROVIDER_MIRROR_PREFIX } from "./mirror-paths";
import type { RegistryWriteStore } from "./writer";

export { PROVIDER_MIRROR_PREFIX, isMirrorVersionPath } from "./mirror-paths";

export const LOCK_FILE = ".terraform.lock.hcl";
/** The two hosts a hostless provider source resolves to. */
export const TERRAFORM_REGISTRY = "registry.terraform.io";
export const OPENTOFU_REGISTRY = "registry.opentofu.org";

/** Directories a lock file is never looked for in: caches and what init or a package manager writes. */
const SKIP = new Set([".git", ".terraform", ".terragrunt-cache", "node_modules", "cdktf.out", ".terragucci"]);

/** Every provider in a lock file, by its full address, with its version. */
export function readLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/provider\s+"([^"]+)"\s*\{([^}]*)\}/g)) {
    const v = /\bversion\s*=\s*"([^"]+)"/.exec(m[2]!);
    if (v) out.set(m[1]!, v[1]!);
  }
  return out;
}

/** The repo's lock files, as `/`-separated paths relative to the repo, sorted. */
export function lockFiles(repo: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (n === LOCK_FILE) {
        out.push(posix.normalize(relative(repo, p).split("\\").join("/")));
        continue;
      }
      if (SKIP.has(n)) continue;
      let dirLike = false;
      try {
        dirLike = statSync(p).isDirectory();
      } catch {
        dirLike = false;
      }
      if (dirLike) walk(p);
    }
  };
  walk(repo);
  return out.sort();
}

/** One provider one lock file pins. */
export interface LockEntry {
  /** The lock file, relative to the repo. */
  lock: string;
  address: string;
  version: string;
}

/** Every provider every lock file pins. */
export function lockEntries(repo: string, files: string[] = lockFiles(repo)): LockEntry[] {
  return files.flatMap((lock) => [...readLock(readFileSync(join(repo, lock), "utf-8"))].map(([address, version]) => ({ lock, address, version })));
}

/** Lock files that pin the same providers at the same versions, mirrored once. */
export interface MirrorGroup {
  /** The lock files, relative to the repo. */
  locks: string[];
  /** The first lock file's text, which `providers mirror` checks downloads against. */
  text: string;
  /** Address to version. */
  providers: Map<string, string>;
}

const byKey = <T>([a]: [string, T], [b]: [string, T]): number => (a < b ? -1 : a > b ? 1 : 0);

/** The repo's lock files grouped by what they pin; a lock file that pins nothing is left out. */
export function mirrorGroups(repo: string, locks: string[] = lockFiles(repo)): MirrorGroup[] {
  const groups = new Map<string, MirrorGroup>();
  for (const lock of locks) {
    const text = readFileSync(join(repo, lock), "utf-8");
    const providers = readLock(text);
    if (providers.size === 0) continue;
    const key = [...providers].sort(byKey).map(([a, v]) => `${a}=${v}`).join("\n");
    const g = groups.get(key);
    if (g) g.locks.push(lock);
    else groups.set(key, { locks: [lock], text, providers });
  }
  return [...groups.values()];
}

/** A file a mirror build writes, relative to its directory. */
export interface MirrorModuleFile {
  path: string;
  content: string;
}

export interface MirrorModuleOptions {
  /** Directory the modules go under. Default `mirror`. */
  dir?: string;
  /** Also require each provider locked on registry.terraform.io or registry.opentofu.org under the other host. Default false. */
  bothHosts?: boolean;
}

/** The other default host's address for a provider locked on one of them, or undefined. */
export function otherHostAddress(address: string): string | undefined {
  const [host, ...rest] = address.split("/");
  if (rest.length !== 2) return undefined;
  const h = host!.toLowerCase();
  if (h === TERRAFORM_REGISTRY) return [OPENTOFU_REGISTRY, ...rest].join("/");
  if (h === OPENTOFU_REGISTRY) return [TERRAFORM_REGISTRY, ...rest].join("/");
  return undefined;
}

/**
 * One module per group: `versions.tf` holding each provider at exactly its
 * locked version, and the lock file beside it so `providers mirror` checks the
 * hashes. With `bothHosts`, the other default host's address is required too;
 * the lock file does not name it, so its download is checked by that
 * registry's signature alone.
 */
export function mirrorModules(groups: MirrorGroup[], options: MirrorModuleOptions = {}): MirrorModuleFile[] {
  const base = options.dir ?? "mirror";
  const files: MirrorModuleFile[] = [];
  groups.forEach((g, i) => {
    const dir = `${base}/${String(i + 1).padStart(2, "0")}`;
    const wanted = new Map(g.providers);
    if (options.bothHosts) {
      for (const [address, version] of g.providers) {
        const other = otherHostAddress(address);
        if (other && ![...wanted.keys()].some((a) => a.toLowerCase() === other.toLowerCase())) wanted.set(other, version);
      }
    }
    const required = [...wanted].sort(byKey).map(([address, version], n) => `    p${n} = { source = "${address}", version = "= ${version}" }`);
    files.push({
      path: `${dir}/versions.tf`,
      content: [`# The providers ${g.locks.join(", ")} lock${g.locks.length === 1 ? "s" : ""}, each at exactly its locked version.`, "terraform {", "  required_providers {", ...required, "  }", "}", ""].join("\n"),
    });
    files.push({ path: `${dir}/${LOCK_FILE}`, content: g.text });
  });
  return files;
}

/** A platform as the binaries name it, `linux_amd64`, from that form or Docker's `linux/amd64`. */
export function binaryPlatform(platform: string): string {
  const p = platform.trim().toLowerCase().replace("/", "_");
  if (!/^[a-z0-9]+_[a-z0-9]+$/.test(p)) throw new Error(`${platform}: name a platform as os_arch or os/arch, such as linux_amd64`);
  return p;
}

/** The platform this process runs on, as the binaries name it. */
export function hostPlatform(platform: string = process.platform, arch: string = process.arch): string {
  const a = arch === "x64" ? "amd64" : arch === "ia32" ? "386" : arch;
  return `${platform}_${a}`;
}

/**
 * Whether a mirror directory holds the provider at the version for the
 * platform, in either layout a `filesystem_mirror` reads: packed (what
 * `providers mirror` writes, a zip per platform) or unpacked (a directory per
 * platform).
 */
export function mirrorHas(mirror: string, address: string, version: string, platform: string): boolean {
  const parts = address.split("/");
  const type = parts[parts.length - 1]!;
  const dir = join(mirror, ...parts);
  return existsSync(join(dir, `terraform-provider-${type}_${version}_${platform}.zip`)) || existsSync(join(dir, version, platform));
}

/** Runs the binary; a test passes its own. */
export type MirrorRun = (bin: string, args: string[], cwd: string) => { status: number | null; output: string };

const defaultRun: MirrorRun = (bin, args, cwd) => {
  const r = spawnSync(bin, args, { cwd, encoding: "utf-8", env: { ...process.env, TF_IN_AUTOMATION: "1", TF_INPUT: "0", CHECKPOINT_DISABLE: "1" } });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}` };
};

export interface BuildMirrorOptions {
  /** The binary that runs `providers mirror`. Default tofu. */
  binary?: string;
  /** Platforms to mirror, `linux_amd64` or `linux/amd64`. Default linux_amd64. */
  platforms?: string[];
  /** Mirror each provider under both default hosts. Default true. */
  bothHosts?: boolean;
  /** The lock files to cover. Default every lock file in the repo. */
  locks?: string[];
  /** Where the modules are written while the binary runs. Default a new temporary directory. */
  workDir?: string;
  run?: MirrorRun;
}

export interface BuiltMirror {
  /** The directory the mirror was written to. */
  out: string;
  /** The lock files covered. */
  locks: string[];
  /** Every provider mirrored, as `address version`, sorted. */
  providers: string[];
  platforms: string[];
}

export class MirrorBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MirrorBuildError";
  }
}

/** The versions every `<version>.json` beside an `index.json` names, as the index lists them. */
const indexFor = (dir: string): string => {
  const versions = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => f.slice(0, -".json".length))
    .sort();
  return `${JSON.stringify({ versions: Object.fromEntries(versions.map((v) => [v, {}])) }, null, 2)}\n`;
};

/** Every provider directory (`<host>/<ns>/<type>`) under a mirror. */
const providerDirs = (out: string): string[] => {
  const dirs: string[] = [];
  const list = (d: string) => (existsSync(d) ? readdirSync(d).filter((n) => statSync(join(d, n)).isDirectory()) : []);
  for (const host of list(out)) for (const ns of list(join(out, host))) for (const type of list(join(out, host, ns))) dirs.push(join(out, host, ns, type));
  return dirs;
};

/**
 * Runs `providers mirror` over every lock file's group into `out`, then
 * rewrites each `index.json` from the version files present, so groups that
 * mirror different versions of one provider all show.
 */
export function buildMirror(repo: string, out: string, options: BuildMirrorOptions = {}): BuiltMirror {
  const binary = options.binary ?? "tofu";
  const platforms = [...new Set((options.platforms?.length ? options.platforms : ["linux_amd64"]).map(binaryPlatform))];
  const bothHosts = options.bothHosts ?? true;
  const groups = mirrorGroups(repo, options.locks ?? lockFiles(repo));
  const work = options.workDir ?? mkdtempSync(join(tmpdir(), "chant-provider-mirror-"));
  const run = options.run ?? defaultRun;
  const modules = mirrorModules(groups, { dir: "mirror", bothHosts });
  for (const f of modules) {
    mkdirSync(join(work, posix.dirname(f.path)), { recursive: true });
    writeFileSync(join(work, f.path), f.content);
  }
  mkdirSync(out, { recursive: true });
  const dirs = [...new Set(modules.map((f) => posix.dirname(f.path)))];
  for (const d of dirs) {
    const r = run(binary, [`-chdir=${join(work, d)}`, "providers", "mirror", ...platforms.map((p) => `-platform=${p}`), out], repo);
    if (r.status !== 0) throw new MirrorBuildError(`${binary} providers mirror for ${d} failed (exit ${r.status}):\n${r.output.trim()}`);
  }
  for (const d of providerDirs(out)) writeFileSync(join(d, "index.json"), indexFor(d));
  const providers = new Set<string>();
  for (const g of groups) {
    for (const [address, version] of g.providers) {
      providers.add(`${address} ${version}`);
      const other = bothHosts ? otherHostAddress(address) : undefined;
      if (other) providers.add(`${other} ${version}`);
    }
  }
  return { out, locks: groups.flatMap((g) => g.locks).sort(), providers: [...providers].sort(), platforms };
}

/** The store a mirror is uploaded to: a registry's write store, with an optional existence check so archives already there are skipped. */
export type MirrorUploadStore = Pick<RegistryWriteStore, "put" | "read"> & { has?(key: string): Promise<boolean> };

export interface UploadMirrorOptions {
  /** The registry's prefix in its store; the mirror goes under `<prefix>/providers/`. */
  prefix?: string;
}

export interface UploadedMirror {
  /** Keys written. */
  put: string[];
  /** Archive keys left as they were, already in the store. */
  kept: string[];
}

const contentTypeOf = (name: string): string => (name.endsWith(".json") ? "application/json" : name.endsWith(".zip") ? "application/zip" : "application/octet-stream");

/** Every file under a directory, relative to it, `/`-separated. */
const walkFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(root, p).split("\\").join("/"));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
};

/** The key a mirror file goes to. */
export const mirrorKey = (prefix: string | undefined, path: string): string => keyFor(prefix, `${PROVIDER_MIRROR_PREFIX}/${path}`);

/** The versions an `index.json` lists. */
const indexVersions = (text: string | undefined): string[] => {
  if (!text) return [];
  try {
    return Object.keys((JSON.parse(text) as { versions?: Record<string, unknown> }).versions ?? {});
  } catch {
    return [];
  }
};

/**
 * Uploads a built mirror: archives, then each `<version>.json`, then each
 * `index.json` merged with the versions the store's copy already lists, so a
 * reader never sees an index naming a version whose files are not there yet.
 */
export async function uploadMirror(store: MirrorUploadStore, dir: string, options: UploadMirrorOptions = {}): Promise<UploadedMirror> {
  const files = walkFiles(dir);
  const rank = (f: string): number => (f.endsWith("/index.json") ? 2 : f.endsWith(".json") ? 1 : 0);
  const ordered = [...files].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const put: string[] = [];
  const kept: string[] = [];
  for (const f of ordered) {
    const key = mirrorKey(options.prefix, f);
    if (rank(f) === 0 && store.has && (await store.has(key))) {
      kept.push(key);
      continue;
    }
    let body: string | Buffer = readFileSync(join(dir, f));
    if (rank(f) === 2) {
      const versions = [...new Set([...indexVersions((await store.read(key)).body), ...indexVersions(body.toString("utf-8"))])].sort();
      body = `${JSON.stringify({ versions: Object.fromEntries(versions.map((v) => [v, {}])) }, null, 2)}\n`;
    }
    await store.put(key, body, contentTypeOf(f));
    put.push(key);
  }
  return { put, kept };
}

/** The mirror's URL under a registry's base URL, ending in `/`. */
export const mirrorUrl = (registryUrl: string, prefix?: string): string => `${registryUrl.replace(/\/+$/, "")}/${mirrorKey(prefix, "")}`;

/**
 * The CLI config block users add: the mirrored providers come only from the
 * mirror, and everything else directly from its registry. `include` keeps
 * the mirror from being asked for a provider it lacks, and `exclude` keeps a
 * mirrored provider from going direct.
 */
export function mirrorCliConfig(url: string, addresses: string[]): string {
  // Takes addresses, or BuiltMirror.providers' `address version` lines.
  const list = [...new Set(addresses.map((a) => a.trim().split(/\s+/)[0]!))].sort();
  const quoted = list.map((a) => `      "${a}",`);
  return [
    "provider_installation {",
    "  network_mirror {",
    `    url = "${url.endsWith("/") ? url : `${url}/`}"`,
    "    include = [",
    ...quoted,
    "    ]",
    "  }",
    "  direct {",
    "    exclude = [",
    ...quoted,
    "    ]",
    "  }",
    "}",
    "",
  ].join("\n");
}

