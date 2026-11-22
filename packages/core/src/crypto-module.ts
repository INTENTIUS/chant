/**
 * Which crypto module made chant's digests and signatures (#5470).
 *
 * chant hashes and signs through `node:crypto`, which runs on the OpenSSL
 * Node is linked with, and signs releases through cosign. A team under a
 * control that asks for validated cryptography needs to say which module
 * each signature came from. This file reports what chant can see:
 *
 * - Node's version and the OpenSSL version it runs on.
 * - Whether Node runs in FIPS mode (`crypto.getFips()`), and in that mode
 *   whether SHA-256, ECDSA P-256 and Ed25519 can be fetched. Node documents
 *   that `getFips()` only says the default property query includes
 *   `fips=yes`, not that a validated provider is loaded, so the fetches are
 *   tried as well.
 * - The cosign binary signing would run, with its SHA-256, and whether that
 *   is the upstream build chant pins in `TOOL_PINS.cosign`.
 *
 * It never says a module is validated. Whether a provider is a validated
 * module, which algorithms its certificate approves, and whether it was
 * deployed as its security policy says are read from the certificate, not
 * from here.
 */

import { createHash, generateKeyPairSync, getFips } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { TOOL_PINS } from "./tool-pins";

/** What one `fips=yes` fetch did. */
export type FipsFetch = { ok: true } | { ok: false; reason: string };

export interface CryptoModuleReport {
  /** `process.version`. */
  node: string;
  /** `process.versions.openssl`. */
  openssl: string;
  /** Whether `crypto.getFips()` is 1: the default property query includes `fips=yes`. */
  fips: boolean;
  /** In FIPS mode, what fetching each algorithm did; null when FIPS mode is off. */
  fetches: { sha256: FipsFetch; ecdsaP256: FipsFetch; ed25519: FipsFetch } | null;
}

export interface CryptoModuleDeps {
  getFips?: () => number;
  versions?: { node?: string; openssl?: string };
  /** Try one algorithm; throws when it can't be fetched. */
  tryAlgorithm?: (algorithm: "sha256" | "ecdsa-p256" | "ed25519") => void;
}

function tryFetch(algorithm: "sha256" | "ecdsa-p256" | "ed25519"): void {
  if (algorithm === "sha256") createHash("sha256").update("chant").digest();
  else if (algorithm === "ecdsa-p256") generateKeyPairSync("ec", { namedCurve: "P-256" });
  else generateKeyPairSync("ed25519");
}

const attempt = (f: () => void): FipsFetch => {
  try {
    f();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
};

/** What this process's crypto runs on. */
export function cryptoModule(deps: CryptoModuleDeps = {}): CryptoModuleReport {
  const fips = (deps.getFips ?? getFips)() === 1;
  const fetchAlgorithm = deps.tryAlgorithm ?? tryFetch;
  return {
    node: deps.versions?.node ?? process.version,
    openssl: deps.versions?.openssl ?? process.versions.openssl ?? "unknown",
    fips,
    fetches: fips ? { sha256: attempt(() => fetchAlgorithm("sha256")), ecdsaP256: attempt(() => fetchAlgorithm("ecdsa-p256")), ed25519: attempt(() => fetchAlgorithm("ed25519")) } : null,
  };
}

/** Whether FIPS mode is on and SHA-256 or ECDSA P-256 can't be fetched in it, so chant's digests or a P-256 runner key would fail. */
export function cryptoModuleBroken(r: CryptoModuleReport): string | null {
  if (!r.fetches) return null;
  const failed = [r.fetches.sha256.ok ? null : `SHA-256 (${(r.fetches.sha256 as { reason: string }).reason})`, r.fetches.ecdsaP256.ok ? null : `ECDSA P-256 (${(r.fetches.ecdsaP256 as { reason: string }).reason})`].filter(Boolean);
  return failed.length > 0 ? `FIPS mode is on, and no loaded provider supplies ${failed.join(" or ")} under fips=yes` : null;
}

/** One line for a doctor: the versions, the mode, and in FIPS mode what fetched. */
export function describeCryptoModule(r: CryptoModuleReport): string {
  const head = `Node ${r.node} on OpenSSL ${r.openssl}`;
  if (!r.fetches) return `${head}; FIPS mode off, so digests and runner-key signatures use OpenSSL's default provider`;
  const word = (f: FipsFetch) => (f.ok ? "fetches" : "does not fetch");
  return (
    `${head}; FIPS mode on: SHA-256 ${word(r.fetches.sha256)}, ECDSA P-256 ${word(r.fetches.ecdsaP256)} and Ed25519 ${word(r.fetches.ed25519)} under fips=yes. ` +
    "Whether the provider is a validated module, and which of these its certificate approves, is in its certificate and security policy"
  );
}

/** The fields a publish record keeps of {@link CryptoModuleReport}. */
export interface CryptoRecord {
  node: string;
  openssl: string;
  fips: boolean;
  /** The cosign `CHANT_COSIGN` named, when it was set. */
  cosign?: { path: string; sha256: string | null; pinned: string | null };
}

export interface CosignBinary {
  /** The file, or `cosign` when none was found on `PATH`. */
  path: string;
  from: "CHANT_COSIGN" | "PATH";
  /** Hex SHA-256 of the file, or null when it can't be read. */
  sha256: string | null;
  /** `cosign v3.1.4 linux/amd64` when the file is that pinned upstream download, else null. */
  pinned: string | null;
  /** Why the file can't be read, when it can't. */
  reason?: string;
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** The pinned upstream cosign a SHA-256 is, or null. */
export function pinnedCosign(sha256: string): string | null {
  const pin = TOOL_PINS.cosign;
  for (const [platform, file] of Object.entries(pin.platforms)) if (file.sha256 === sha256) return `cosign ${pin.version} ${platform}`;
  return null;
}

/**
 * The cosign signing would run, as `cosignPath` picks it (`CHANT_COSIGN`,
 * else `cosign` on `PATH`), its SHA-256, and whether it is the upstream build
 * chant's release workflow downloads. Any other build, such as a FIPS build
 * a team supplies through `CHANT_COSIGN`, is reported by its digest alone.
 */
export function cosignBinary(env: NodeJS.ProcessEnv, deps: { read?: (path: string) => Buffer } = {}): CosignBinary {
  const fromEnv = env.CHANT_COSIGN && env.CHANT_COSIGN !== "" ? env.CHANT_COSIGN : undefined;
  const path = fromEnv ?? onPath("cosign", env);
  const from = fromEnv ? "CHANT_COSIGN" : "PATH";
  if (!path) return { path: "cosign", from, sha256: null, pinned: null, reason: "there is no cosign on PATH" };
  try {
    const sha256 = createHash("sha256").update((deps.read ?? readFileSync)(path)).digest("hex");
    return { path, from, sha256, pinned: pinnedCosign(sha256) };
  } catch (err) {
    return { path, from, sha256: null, pinned: null, reason: `${path} can't be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** One line for a doctor: which cosign, and whether it is chant's pinned upstream build. */
export function describeCosignBinary(c: CosignBinary): string {
  if (c.sha256 === null) return `${c.from === "CHANT_COSIGN" ? "CHANT_COSIGN names " : ""}${c.path}, whose build can't be told: ${c.reason}`;
  const where = c.from === "CHANT_COSIGN" ? `CHANT_COSIGN names ${c.path}` : `${c.path} on PATH`;
  return c.pinned
    ? `${where}, the upstream ${c.pinned} chant's release workflow downloads (sha256 ${c.sha256.slice(0, 12)})`
    : `${where}, sha256 ${c.sha256}, which is not the cosign chant pins: a build the job supplies, whose crypto module is that build's`;
}

/**
 * What a publish record keeps (#5470): the Node, OpenSSL and FIPS mode its
 * digests were made under, and the cosign `CHANT_COSIGN` named. Read once
 * per publish.
 */
export function cryptoRecord(env: NodeJS.ProcessEnv, deps: CryptoModuleDeps & { read?: (path: string) => Buffer } = {}): CryptoRecord {
  const m = cryptoModule({ ...deps, tryAlgorithm: deps.tryAlgorithm ?? (() => undefined) });
  const out: CryptoRecord = { node: m.node, openssl: m.openssl, fips: m.fips };
  if (env.CHANT_COSIGN) {
    const c = cosignBinary(env, deps.read ? { read: deps.read } : {});
    out.cosign = { path: c.path, sha256: c.sha256, pinned: c.pinned };
  }
  return out;
}
