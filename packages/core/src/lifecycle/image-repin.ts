/**
 * Re-pinning image references to the digest their tag names today (#5457).
 *
 * A reference pinned by digest keeps the tag it followed beside it:
 * `node:22-bookworm-slim@sha256:<digest>`. Re-pinning asks the registry what
 * index digest the tag names now and, when it moved, rewrites the digest in
 * place, keeping the tag. Nothing else in the file changes, and a reference
 * whose tag still names the same digest is left as it is, so a run with
 * nothing to move writes nothing.
 *
 * {@link pinnedReferences} finds two shapes in any text file:
 *
 * - `<name>:<tag>@sha256:<digest>`, as a Dockerfile's `FROM` and `ARG`
 *   defaults, and chant's `CI_BASE_IMAGES`, write it;
 * - `pin("<repository>", "<tag>", "sha256:<digest>")`, a row of chant's
 *   `IMAGE_PINS`.
 *
 * A reference with a digest and no tag has nothing to follow and is left. A
 * `FROM` by tag alone is not re-pinned either: the `supply-chain` check
 * reports it, and pinning it the first time is a person's choice of digest.
 *
 * `chant release images --repin` runs it on the Dockerfiles `release.images`
 * names, or on the files it is given, such as chant's own
 * `packages/core/src/image-pins.ts` and `packages/core/src/ci-image.ts`, and
 * prints what moved so a scheduled job can open a pull request with it.
 *
 * It moves Wolfi package versions the same way (#5445). {@link apkPinnedReferences}
 * finds two more shapes:
 *
 * - `apk("<name>", "<version>", "<date>")`, a row of chant's
 *   `WOLFI_PACKAGE_PINS`;
 * - `apk:<name>=<version>`, a product's own entry in a Chainguard image's
 *   `packages`.
 *
 * Each moves to the newest version that Wolfi's index lists for every
 * architecture chant builds ({@link wolfiResolver}), and a row's date becomes
 * the day it moved. An `apk add` line in a rendered Dockerfile is not
 * rewritten: the product moves its source and renders the Dockerfile again.
 */

import { gunzipSync } from "node:zlib";
import { tarEntry } from "../policy-engine";
import { ociCredential, parseRepository, Registry } from "./publish-oci";
import { createRedactor } from "./publish-credentials";
import type { PublishFetch } from "./release-publish";

/** One pinned reference in a file. */
export interface PinnedReference {
  /** Where the digest starts in the text, and the digest as written. */
  at: number;
  digest: string;
  /** The line it is on, from 1. */
  line: number;
  repository: string;
  tag: string;
}

/** `<name>:<tag>@sha256:<digest>`, with an optional registry host and port. */
const REFERENCE = /(?<![A-Za-z0-9._/:@-])((?:[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*):([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})@(sha256:[0-9a-f]{64})/g;
/** `pin("<repository>", "<tag>", "sha256:<digest>")`. */
const PIN_CALL = /\bpin\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"(sha256:[0-9a-f]{64})"\s*\)/g;

/** Every pinned reference in `text` that names a tag, in the order they appear. */
export function pinnedReferences(text: string): PinnedReference[] {
  const lineOf = (at: number) => text.slice(0, at).split("\n").length;
  const out: PinnedReference[] = [];
  for (const m of text.matchAll(REFERENCE)) {
    const at = m.index! + m[0].length - m[3]!.length;
    out.push({ at, digest: m[3]!, line: lineOf(at), repository: m[1]!, tag: m[2]! });
  }
  for (const m of text.matchAll(PIN_CALL)) {
    const at = m.index! + m[0].lastIndexOf(m[3]!);
    out.push({ at, digest: m[3]!, line: lineOf(at), repository: m[1]!, tag: m[2]! });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Resolves `<repository>:<tag>` to the digest of the manifest or index the tag names now. */
export type ImageResolver = (repository: string, tag: string) => Promise<string>;

/**
 * An {@link ImageResolver} that asks each image's registry, with a pull-only
 * token. Credentials come from `OCI_USERNAME` and `OCI_PASSWORD`, else the
 * docker config's `auths` entry for the registry; with none, it asks
 * anonymously, which public images allow.
 */
export function registryResolver(env: NodeJS.ProcessEnv, fetchImpl: PublishFetch = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<PublishFetch>): ImageResolver {
  const redactor = createRedactor(env);
  return async (repository, tag) => {
    const repo = parseRepository(repository);
    const cred = ociCredential({}, repo, { env, redactor });
    const registry = new Registry(repo, fetchImpl, cred, { cwd: ".", env, redactor, log: () => undefined, provenance: { oidc: false, ci: null, reason: "" }, tag: null });
    registry.actions = "pull";
    const found = await registry.getManifest(tag);
    if (!found) throw new Error(`${repository}:${tag} is not in ${repo.base}`);
    return found.digest;
  };
}

/** One reference whose tag names another digest now. */
export interface RepinMove {
  file: string;
  line: number;
  /** `<repository>:<tag>`. */
  reference: string;
  from: string;
  to: string;
}

/** What a re-pin did. */
export interface RepinResult {
  /** Each file with its text after the re-pin, and whether it changed. */
  files: Array<{ path: string; text: string; changed: boolean }>;
  moved: RepinMove[];
  /** How many references still name the digest their tag names, or the version the index gives. */
  unchanged: number;
  /** References whose tag could not be resolved, and why; their digests are left. */
  failed: Array<{ file: string; line: number; reference: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Wolfi package versions (#5445)

/** One pinned apk package in a file: a `WOLFI_PACKAGE_PINS` row or a product's `apk:<name>=<version>` entry. */
export interface ApkPinnedReference {
  /** Where the version starts in the text, and the version as written. */
  at: number;
  version: string;
  line: number;
  name: string;
  /** A row's date and where it starts; an entry has none. */
  date?: { at: number; value: string };
}

const APK_NAME = "[a-z0-9][a-z0-9.+_-]*";
/** An apk version with its package revision, as Wolfi writes every one: `2.56.1-r1`, `10.6_p2-r0`, `2026f-r1`. */
export const APK_VERSION = /^[0-9][0-9A-Za-z._+~]*-r[0-9]+$/;
const APK_VERSION_SRC = "[0-9][0-9A-Za-z._+~]*-r[0-9]+";
/** `apk("<name>", "<version>", "<yyyy-mm-dd>")`. */
const APK_ROW = new RegExp(`(\\bapk\\(\\s*"(${APK_NAME})"\\s*,\\s*")(${APK_VERSION_SRC})("\\s*,\\s*")(\\d{4}-\\d{2}-\\d{2})"\\s*\\)`, "g");
/** `apk:<name>=<version>`, not inside a longer word. */
const APK_ENTRY = new RegExp(`(?<![A-Za-z0-9_-])apk:(${APK_NAME})=(${APK_VERSION_SRC})(?![0-9A-Za-z._+~-])`, "g");

/** Every pinned apk package in `text`, in the order they appear. */
export function apkPinnedReferences(text: string): ApkPinnedReference[] {
  const lineOf = (at: number) => text.slice(0, at).split("\n").length;
  const out: ApkPinnedReference[] = [];
  for (const m of text.matchAll(APK_ROW)) {
    const at = m.index! + m[1]!.length;
    out.push({ at, version: m[3]!, line: lineOf(at), name: m[2]!, date: { at: at + m[3]!.length + m[4]!.length, value: m[5]! } });
  }
  for (const m of text.matchAll(APK_ENTRY)) {
    const at = m.index! + "apk:".length + m[1]!.length + 1;
    out.push({ at, version: m[2]!, line: lineOf(at), name: m[1]! });
  }
  return out.sort((a, b) => a.at - b.at);
}

const PRE_SUFFIXES = ["alpha", "beta", "pre", "rc"];
const POST_SUFFIXES = ["cvs", "svn", "git", "hg", "p"];

interface ApkVersionParts {
  numbers: number[];
  letter: string;
  /** Each suffix as its rank (below 0 before a release, above 0 after) and its number. */
  suffixes: Array<[number, number]>;
  revision: number;
}

function apkVersionParts(version: string): ApkVersionParts | undefined {
  const m = /^(\d+(?:\.\d+)*)([a-z]?)((?:_[a-z]+\d*)*)(?:-r(\d+))?$/.exec(version);
  if (!m) return undefined;
  const suffixes: Array<[number, number]> = [];
  for (const s of m[3]!.split("_").filter(Boolean)) {
    const sm = /^([a-z]+)(\d*)$/.exec(s)!;
    const pre = PRE_SUFFIXES.indexOf(sm[1]!);
    const post = POST_SUFFIXES.indexOf(sm[1]!);
    if (pre < 0 && post < 0) return undefined;
    suffixes.push([pre >= 0 ? pre - PRE_SUFFIXES.length : post + 1, Number(sm[2] || 0)]);
  }
  return { numbers: m[1]!.split(".").map(Number), letter: m[2]!, suffixes, revision: Number(m[4] ?? 0) };
}

/**
 * apk's version order, for the versions Wolfi publishes: numbers by value, a
 * longer number list after a shorter one it starts with, a letter after
 * none, `_alpha` `_beta` `_pre` `_rc` before the release and `_p` and the
 * like after it, then the `-r` revision. A version this cannot read sorts
 * before every one it can.
 */
export function compareApkVersions(a: string, b: string): number {
  const pa = apkVersionParts(a);
  const pb = apkVersionParts(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < Math.max(pa.numbers.length, pb.numbers.length); i++) {
    const x = pa.numbers[i];
    const y = pb.numbers[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.letter !== pb.letter) return pa.letter < pb.letter ? -1 : 1;
  for (let i = 0; i < Math.max(pa.suffixes.length, pb.suffixes.length); i++) {
    const [xr, xn] = pa.suffixes[i] ?? [0, 0];
    const [yr, yn] = pb.suffixes[i] ?? [0, 0];
    if (xr !== yr) return xr < yr ? -1 : 1;
    if (xn !== yn) return xn < yn ? -1 : 1;
  }
  return pa.revision === pb.revision ? 0 : pa.revision < pb.revision ? -1 : 1;
}

/** An APKINDEX's text: each package's versions by name (`P:` and `V:` of each record). */
export function parseApkIndex(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const record of text.split(/\n\n+/)) {
    let name: string | undefined;
    let version: string | undefined;
    for (const line of record.split("\n")) {
      if (line.startsWith("P:")) name = line.slice(2);
      else if (line.startsWith("V:")) version = line.slice(2);
    }
    if (name && version) {
      const list = out.get(name);
      if (list) list.push(version);
      else out.set(name, [version]);
    }
  }
  return out;
}

/** The APKINDEX inside an `APKINDEX.tar.gz` as apk serves it: a signature and the index, gzip streams one after the other. */
export function apkIndexArchiveText(archive: Uint8Array): string {
  const index = tarEntry(gunzipSync(archive), "APKINDEX");
  if (!index) throw new Error("the archive holds no APKINDEX");
  return Buffer.from(index).toString("utf-8");
}

/** The newest version of `name` that every index lists, or undefined when they share none. */
export function newestCommonApkVersion(indexes: ReadonlyArray<Map<string, string[]>>, name: string): string | undefined {
  if (indexes.length === 0) return undefined;
  let common: Set<string> | undefined;
  for (const index of indexes) {
    const here = new Set(index.get(name) ?? []);
    common = common ? new Set([...common].filter((v) => here.has(v))) : here;
  }
  const versions = [...(common ?? [])].filter((v) => APK_VERSION.test(v));
  return versions.sort(compareApkVersions).at(-1);
}

/** Resolves an apk package to the version it should be pinned at today. */
export type ApkResolver = (name: string) => Promise<string>;

/** The architectures a Chainguard image is built for, as Wolfi's index names them. */
export const WOLFI_ARCHES = ["x86_64", "aarch64"] as const;

/** Wolfi's package index for one architecture. */
export const wolfiIndexUrl = (arch: string): string => `https://packages.wolfi.dev/os/${arch}/APKINDEX.tar.gz`;

/**
 * An {@link ApkResolver} over Wolfi's public index: each architecture's
 * index is read once, on the first package asked for, and a package
 * resolves to the newest version every architecture lists, so one
 * `apk add` line builds both.
 */
export function wolfiResolver(fetchImpl: (url: string) => Promise<Uint8Array> = fetchArchive): ApkResolver {
  let indexes: Promise<Array<Map<string, string[]>>> | undefined;
  return async (name) => {
    indexes ??= Promise.all(WOLFI_ARCHES.map(async (arch) => parseApkIndex(apkIndexArchiveText(await fetchImpl(wolfiIndexUrl(arch))))));
    const version = newestCommonApkVersion(await indexes, name);
    if (!version) throw new Error(`Wolfi's index lists no version of ${name} for both ${WOLFI_ARCHES.join(" and ")}`);
    return version;
  };
}

async function fetchArchive(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Re-pinning files

export interface RepinOptions {
  /** Resolves apk packages, for `WOLFI_PACKAGE_PINS` rows and `apk:<name>=<version>` entries. Without it, each is reported as failed. */
  apk?: ApkResolver;
  /** The date a moved row records, `yyyy-mm-dd`. Default today, in UTC. */
  today?: string;
}

/**
 * Re-pin every reference in `files` with `resolve`, asking once per
 * `<repository>:<tag>`, and every apk package with `options.apk`, asking
 * once per name.
 */
export async function repinFiles(files: ReadonlyArray<{ path: string; text: string }>, resolve: ImageResolver, options: RepinOptions = {}): Promise<RepinResult> {
  const memo = <T>(fn: (key: string) => Promise<T>) => {
    const cache = new Map<string, Promise<T>>();
    return (key: string) => {
      let p = cache.get(key);
      if (!p) {
        p = fn(key);
        cache.set(key, p);
      }
      return p;
    };
  };
  const askImage = memo((key) => {
    const colon = key.lastIndexOf(":");
    return resolve(key.slice(0, colon), key.slice(colon + 1));
  });
  const apk = options.apk;
  const askApk = memo((name) => (apk ? apk(name) : Promise.reject(new Error("no package index was given to read apk versions from"))));
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const result: RepinResult = { files: [], moved: [], unchanged: 0, failed: [] };
  for (const file of files) {
    type Found = { at: number; line: number; reference: string; current: string; ask: () => Promise<string>; date?: { at: number; value: string } };
    const found: Found[] = [
      ...pinnedReferences(file.text).map((r) => ({ at: r.at, line: r.line, reference: `${r.repository}:${r.tag}`, current: r.digest, ask: () => askImage(`${r.repository}:${r.tag}`) })),
      ...apkPinnedReferences(file.text).map((r) => ({ at: r.at, line: r.line, reference: `apk:${r.name}`, current: r.version, ask: () => askApk(r.name), ...(r.date ? { date: r.date } : {}) })),
    ].sort((a, b) => a.at - b.at);
    const edits: Array<{ at: number; length: number; text: string }> = [];
    for (const ref of found) {
      let now: string;
      try {
        now = await ref.ask();
      } catch (err) {
        result.failed.push({ file: file.path, line: ref.line, reference: ref.reference, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (now === ref.current) {
        result.unchanged++;
        continue;
      }
      edits.push({ at: ref.at, length: ref.current.length, text: now });
      if (ref.date) edits.push({ at: ref.date.at, length: ref.date.value.length, text: today });
      result.moved.push({ file: file.path, line: ref.line, reference: ref.reference, from: ref.current, to: now });
    }
    // Rewrite from the end, so an earlier edit's offset is not moved by a later one.
    let text = file.text;
    for (const e of edits.sort((a, b) => b.at - a.at)) text = text.slice(0, e.at) + e.text + text.slice(e.at + e.length);
    result.files.push({ path: file.path, text, changed: text !== file.text });
  }
  return result;
}
