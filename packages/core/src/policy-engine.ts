/**
 * The policy engine's binary (#4774): conftest or OPA at a pinned release,
 * fetched once, checked against the sha256 chant records for it, and kept in
 * a cache directory.
 *
 * `ci.policy.install: true` makes the pull-request jobs and Op waves use it
 * (`./components/pr-policy.ts`). A product that runs the engine itself calls
 * {@link policyEngineBinary} with its own `download`, `cache` and `exec`, so
 * it keeps no download code. Tests pass `download`, so nothing reaches the
 * network.
 *
 * The digests are the release's own: conftest's `checksums.txt` and OPA's
 * `.sha256` files, checked against the archives themselves when the pins
 * were set. A download that does not match its pin is never written to the
 * cache. A caller pinning another release passes its `version` and the
 * sha256 for the platform; chant fetches nothing without a pin.
 *
 * Like `./gate-policy.ts` this module imports only node built-ins (and the
 * release-floor constant), so a product can bundle it.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/** The first chant with `ci.policy.install` and `@intentius/chant/policy-engine` (#4774). Products feature-detect on it. */
export const POLICY_ENGINE_INSTALL_FLOOR = "0.124.77";

export type PolicyEngineName = "conftest" | "opa";

/** The platforms chant has pins for. */
export type PolicyEnginePlatform = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64";
export const POLICY_ENGINE_PLATFORMS: readonly PolicyEnginePlatform[] = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

/** The conftest release chant installs. */
export const CONFTEST_VERSION = "0.71.1";
/** The OPA release chant installs. */
export const OPA_VERSION = "1.21.4";

/**
 * The sha256 of each pinned release file, as `<engine>-<version>-<platform>`,
 * copied from the release's checksums (conftest's `checksums.txt`, OPA's
 * `<asset>.sha256`) and checked against the files. The files are conftest's
 * `conftest_<v>_<OS>_<arch>.tar.gz` and OPA's static builds, except on
 * darwin-x64, where OPA builds none and the file is `opa_darwin_amd64`. Add
 * a release's lines when moving a default version.
 */
export const POLICY_ENGINE_SHA256: Readonly<Record<string, string>> = {
  "conftest-0.71.1-linux-x64": "c3f6b2a753bd56e377a1e51a95ae3e057f926f2e9139f7d5b5dfbbaf810f7985",
  "conftest-0.71.1-linux-arm64": "218c682e110ae7e826dc14a746a6f9b43eb782643dbe730b771fd305634e3f47",
  "conftest-0.71.1-darwin-x64": "a309853b5763c18486768157442d440248ee683b20a2aa1f6b28214e818bd780",
  "conftest-0.71.1-darwin-arm64": "e1cc50d2590b6c5e3da6912666a71264bae82d60bdd62d7ae2b99971ccc8eedd",
  "opa-1.21.4-linux-x64": "2ab571f367f293bb19523b76f92f1945bbf245003392c7f392903f95c2b9b630",
  "opa-1.21.4-linux-arm64": "810aa96e44f1f852d044888cf830324e44eafd0f510345339011347ab4deaab1",
  "opa-1.21.4-darwin-x64": "8802bd39bc14b58a705e6b3d4f4dd14f7f24ee657f0362c737338be243190c7e",
  "opa-1.21.4-darwin-arm64": "4c105208a9282f590385bccbe600875c011f0894ccf9431782dfe855e1f99aa6",
};

/** One release file of one engine for one platform. */
export interface PolicyEngineRelease {
  engine: PolicyEngineName;
  version: string;
  platform: PolicyEnginePlatform;
  /** The release file's name. OPA ships a bare binary, conftest a `.tar.gz` holding `conftest`. */
  asset: string;
  url: string;
  /** Whether the file is a `.tar.gz` to unpack. */
  archive: boolean;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The release file of `engine` at `version` for `platform`. A version is a plain semver. */
export function policyEngineRelease(engine: PolicyEngineName, platform: PolicyEnginePlatform, version = engine === "opa" ? OPA_VERSION : CONFTEST_VERSION): PolicyEngineRelease {
  if (!VERSION.test(version)) throw new Error(`${engine} version ${JSON.stringify(version)} is not a release version such as ${engine === "opa" ? OPA_VERSION : CONFTEST_VERSION}`);
  const [os, cpu] = platform.split("-") as ["linux" | "darwin", "x64" | "arm64"];
  if (engine === "conftest") {
    const asset = `conftest_${version}_${os === "linux" ? "Linux" : "Darwin"}_${cpu === "x64" ? "x86_64" : "arm64"}.tar.gz`;
    return { engine, version, platform, asset, url: `https://github.com/open-policy-agent/conftest/releases/download/v${version}/${asset}`, archive: true };
  }
  // OPA builds no static binary for darwin on amd64.
  const asset = `opa_${os}_${cpu === "x64" ? "amd64" : "arm64"}${platform === "darwin-x64" ? "" : "_static"}`;
  return { engine, version, platform, asset, url: `https://github.com/open-policy-agent/opa/releases/download/v${version}/${asset}`, archive: false };
}

/** The sha256 chant records for a release file, or undefined when it records none. */
export function pinnedPolicyEngineSha256(release: PolicyEngineRelease): string | undefined {
  return POLICY_ENGINE_SHA256[`${release.engine}-${release.version}-${release.platform}`];
}

/** This process's platform as chant pins it. Throws on one with no pin. */
export function policyEnginePlatform(platform: string = process.platform, arch: string = process.arch): PolicyEnginePlatform {
  const os = platform === "linux" || platform === "darwin" ? platform : undefined;
  const cpu = arch === "x64" || arch === "x86_64" || arch === "amd64" ? "x64" : arch === "arm64" || arch === "aarch64" ? "arm64" : undefined;
  if (!os || !cpu) throw new Error(`chant pins conftest and OPA for ${POLICY_ENGINE_PLATFORMS.join(", ")}, not ${platform}-${arch}; put the engine on PATH instead`);
  return `${os}-${cpu}`;
}

/** Where installed engines are kept by default: `CHANT_TOOL_CACHE`, else `chant-tools` in the temp directory. */
export function defaultPolicyEngineCache(): string {
  return process.env.CHANT_TOOL_CACHE || join(tmpdir(), "chant-tools");
}

export interface InstallPolicyEngineOptions {
  /** Fetches a release file. Default: Node's fetch. Tests pass their own. */
  download?: (url: string) => Promise<Uint8Array>;
  /** Where installed engines are kept. Default {@link defaultPolicyEngineCache}. */
  cache?: string;
  /** The platform to fetch for. Default this process's ({@link policyEnginePlatform}). */
  platform?: PolicyEnginePlatform;
  /** Another release than chant's default. Needs `sha256` for the platform. */
  version?: string;
  /** The release file's sha256 by platform, in place of {@link POLICY_ENGINE_SHA256}. */
  sha256?: Partial<Record<PolicyEnginePlatform, string>>;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The bytes of the regular file `name` (at the top, or under `./`) in a tar stream. Undefined when it holds none. */
export function tarEntry(tar: Uint8Array, name: string): Uint8Array | undefined {
  const text = (from: number, len: number): string => {
    const raw = Buffer.from(tar.subarray(from, from + len)).toString("utf-8");
    const nul = raw.indexOf("\0");
    return nul < 0 ? raw : raw.slice(0, nul);
  };
  let at = 0;
  while (at + 512 <= tar.length) {
    if (tar.subarray(at, at + 512).every((b) => b === 0)) return undefined;
    const prefix = text(at + 345, 155);
    const entry = (prefix ? `${prefix}/` : "") + text(at, 100);
    const size = parseInt(text(at + 124, 12).trim() || "0", 8);
    const type = text(at + 156, 1);
    const body = at + 512;
    if ((type === "" || type === "0") && entry.replace(/^\.\//, "") === name) return tar.subarray(body, body + size);
    at = body + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

/**
 * Install `engine` into the cache and return the binary's path. A binary
 * already installed there for that release and platform is returned without
 * a download. Throws when the platform has no pin, the download fails, or
 * the file does not match its pin.
 */
export async function installPolicyEngine(engine: PolicyEngineName, options: InstallPolicyEngineOptions = {}): Promise<string> {
  const platform = options.platform ?? policyEnginePlatform();
  const release = policyEngineRelease(engine, platform, options.version);
  const want = options.sha256 ? options.sha256[platform] : pinnedPolicyEngineSha256(release);
  if (want === undefined) throw new Error(`chant records no sha256 for ${engine} ${release.version} on ${platform} (${release.asset}); pass sha256 for it, or use ${engine === "opa" ? OPA_VERSION : CONFTEST_VERSION}`);
  if (!SHA256.test(want)) throw new Error(`the sha256 for ${release.asset} is not 64 hex digits`);
  const dir = join(options.cache ?? defaultPolicyEngineCache(), `${engine}-${release.version}-${platform}`);
  const bin = join(dir, engine);
  if (existsSync(bin)) return bin;
  const body = await (options.download ?? fetchBytes)(release.url);
  const sum = createHash("sha256").update(body).digest("hex");
  if (sum !== want) throw new Error(`${engine} ${release.version} from ${release.url} does not match its pinned sha256 (want ${want}, got ${sum}); not running it`);
  const binary = release.archive ? tarEntry(gunzipSync(body), engine) : body;
  if (!binary) throw new Error(`${release.asset} holds no ${engine} binary`);
  mkdirSync(dir, { recursive: true });
  // Written beside its final name and renamed, so a job that stops halfway leaves no binary behind.
  const part = join(dir, `.${engine}.${randomBytes(6).toString("hex")}`);
  writeFileSync(part, binary);
  chmodSync(part, 0o755);
  renameSync(part, bin);
  return bin;
}

/** Whether the engine on PATH answers. Default: runs `conftest --version` or `opa version`. */
export type PolicyEngineProbe = (engine: PolicyEngineName) => boolean;

export const defaultPolicyEngineProbe: PolicyEngineProbe = (engine) => {
  const r = spawnSync(engine, engine === "opa" ? ["version"] : ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
};

export interface PolicyEngineBinaryOptions extends InstallPolicyEngineOptions {
  /** Checks the engine on PATH. Default {@link defaultPolicyEngineProbe}. */
  probe?: PolicyEngineProbe;
  /** Skip the PATH and always use the pinned release. Default false. */
  pinnedOnly?: boolean;
}

/**
 * The engine's executable: its name when the one on PATH answers (an image
 * that carries the engine pays nothing), else the pinned release installed
 * by {@link installPolicyEngine}.
 */
export async function policyEngineBinary(engine: PolicyEngineName, options: PolicyEngineBinaryOptions = {}): Promise<string> {
  if (!options.pinnedOnly && (options.probe ?? defaultPolicyEngineProbe)(engine)) return engine;
  return installPolicyEngine(engine, options);
}
