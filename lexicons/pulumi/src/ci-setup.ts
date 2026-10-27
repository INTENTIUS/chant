/**
 * The engine install lines a Pulumi project's pull request pipeline runs in
 * chant's default image (#4550, `LexiconPlugin.ciSetup`): Pulumi, or plunge
 * when the member's engine is plunge (`pulumiMemberEngine`, #4559).
 *
 * Each line installs one release (#4592), modelled on plywood#12's
 * (INTENTIUS/plywood 9b24b50847, packages/plywood/src/images.ts):
 *
 * - it takes a version, by default {@link PULUMI_CI_VERSION} or
 *   {@link PLUNGE_CI_VERSION};
 * - it downloads the Linux archive for the job's architecture and the
 *   release's own checksums file (Pulumi's `pulumi-<ver>-checksums.txt`,
 *   plunge's `plunge-v<ver>-checksums.txt`), and fails unless the archive's
 *   line is there and matches the archive (`sha256sum -c`);
 * - for a release with a recorded sum ({@link PINNED_SHA256}, or the
 *   caller's `sha256`), the line must also hold that sum, so a tampered
 *   checksums file fails as a tampered archive does;
 * - it unpacks under a versioned path, `/opt/chant/<engine>-<version>/`,
 *   with the language hosts beside the binary, and links the binary into
 *   /usr/local/bin;
 * - it skips the download when that directory already holds the binary,
 *   and for Pulumi also when the `pulumi` on PATH is that version, so an
 *   image that carries the engine pays nothing.
 *
 * A product with images of its own (plywood keeps its engines under
 * /opt/plywood) passes `root`, so the lines find what its image carries.
 */
import { pulumiMemberEngine } from "./member-engine";

export type CiEngine = "pulumi" | "plunge";

/** The Pulumi release the default lines install: the plunge corpus's, which plunge 0.1.0 is built from. */
export const PULUMI_CI_VERSION = "3.272.0";

/** The plunge release the default lines install (INTENTIUS/plunge, tag plunge-v<ver>), not the Pulumi version it is built from. */
export const PLUNGE_CI_VERSION = "0.1.0";

/** Where the lines install each release by default. */
export const CI_ENGINE_ROOT = "/opt/chant";

/** The archive's architecture word, as both projects name their Linux builds. */
export type CiArch = "x64" | "arm64";
export const CI_ARCHES: readonly CiArch[] = ["x64", "arm64"];

/**
 * The sha256 of each recorded Linux archive, copied from its release's
 * checksums file (the same sums plywood#12 records). A checksums file that
 * lists another sum for one of these fails the install. Add a release's
 * two lines when moving a default version.
 */
export const PINNED_SHA256: Readonly<Record<string, string>> = {
  "pulumi-v3.272.0-linux-x64.tar.gz": "58d545f2b98761051922008ebd381ecef95484d7f7a5ff7faa15d7a780ea84f6",
  "pulumi-v3.272.0-linux-arm64.tar.gz": "4f0741901b8982c4326b702dabf483c63d2cf77c88ac42dd752b72541284a534",
  "plunge-v0.1.0-linux-x64.tar.gz": "22b89da39ab7dc11268c7b625fec3d99c0793c9c47bf8d031fa94e6967ee8187",
  "plunge-v0.1.0-linux-arm64.tar.gz": "6855611b8cf8381d73f5ddf0b5c0a0d83bdc2a5bd8c50d415e52bb05a4574f83",
};

/** What a caller may set on an install line. */
export interface CiInstallOptions {
  /** Where the versioned directories live. Default {@link CI_ENGINE_ROOT}. */
  root?: string;
  /** Recorded sums by architecture, in place of {@link PINNED_SHA256}'s for this release. */
  sha256?: Partial<Record<CiArch, string>>;
}

/** One release's download: the base URL, the archive per architecture, and its checksums file. */
export interface CiRelease {
  base: string;
  archive(arch: CiArch): string;
  checksums: string;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ROOT = /^\/[A-Za-z0-9._/-]*$/;

/** The release of `engine` at `version`. A version is a plain semver, so it is safe on a shell line. */
export function ciRelease(engine: CiEngine, version: string): CiRelease {
  if (!VERSION.test(version)) throw new Error(`${engine} version ${JSON.stringify(version)} is not a release version such as 3.272.0`);
  if (engine === "pulumi") {
    return {
      base: `https://github.com/pulumi/pulumi/releases/download/v${version}`,
      archive: (arch) => `pulumi-v${version}-linux-${arch}.tar.gz`,
      checksums: `pulumi-${version}-checksums.txt`,
    };
  }
  return {
    base: `https://github.com/INTENTIUS/plunge/releases/download/plunge-v${version}`,
    archive: (arch) => `plunge-v${version}-linux-${arch}.tar.gz`,
    checksums: `plunge-v${version}-checksums.txt`,
  };
}

/** Where one release of one engine lives after its line runs. */
export function ciEngineDir(engine: CiEngine, version: string, root = CI_ENGINE_ROOT): string {
  if (!ROOT.test(root)) throw new Error(`an engine root is an absolute path of letters, digits and ._/-, not ${JSON.stringify(root)}`);
  return `${root.replace(/\/+$/, "")}/${engine}-${version}`;
}

/** The recorded sums for `version`, by architecture: the caller's, else {@link PINNED_SHA256}'s. */
export function recordedSums(engine: CiEngine, version: string, given?: Partial<Record<CiArch, string>>): Partial<Record<CiArch, string>> {
  const r = ciRelease(engine, version);
  const out: Partial<Record<CiArch, string>> = {};
  for (const arch of CI_ARCHES) {
    const sum = given ? given[arch] : PINNED_SHA256[r.archive(arch)];
    if (sum === undefined) continue;
    if (!SHA256.test(sum)) throw new Error(`the recorded sha256 for ${r.archive(arch)} is not 64 hex digits`);
    out[arch] = sum;
  }
  return out;
}

/** The job's architecture as x64 or arm64. */
const JOB_ARCH = `"$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"`;

/**
 * Shell that downloads one release into `dir` and checks it against the
 * release's checksums file and, when recorded, the sum per architecture.
 * Both archives unpack a top directory named after the engine, which
 * `--strip-components=1` drops.
 */
function fetchScript(engine: CiEngine, version: string, dir: string, sums: Partial<Record<CiArch, string>>): string {
  const r = ciRelease(engine, version);
  const recorded = CI_ARCHES.filter((a) => sums[a]);
  const pinCase = recorded.length > 0 ? `case "$a" in ${recorded.map((a) => `${a}) want=${sums[a]} ;;`).join(" ")} *) want= ;; esac` : "want=";
  const file = r.archive("x64").replace("-x64.", "-$a.");
  return [
    `a=${JOB_ARCH}`,
    `f="${file}"`,
    `t="$(mktemp -d)"`,
    `curl -fsSLo "$t/$f" "${r.base}/$f"`,
    `curl -fsSLo "$t/sums" "${r.base}/${r.checksums}"`,
    // The archive's line, with any ./ or * before the name taken off.
    `line="$(sed -n "s#^\\([0-9a-f]\\{64\\}\\)  *[*.]*/*$f\\$#\\1#p" "$t/sums")"`,
    `{ [ -n "$line" ] || { echo "${engine} ${version}: $f is not in ${r.checksums}" >&2; exit 1; }; }`,
    pinCase,
    `{ [ -z "$want" ] || [ "$line" = "$want" ] || { echo "${engine} ${version}: ${r.checksums} lists $line for $f; chant records $want" >&2; exit 1; }; }`,
    `echo "$line  $t/$f" | sha256sum -c - >/dev/null`,
    `mkdir -p "${dir}"`,
    `tar -xzf "$t/$f" -C "${dir}" --strip-components=1`,
  ].join(" && ");
}

/** The line for one engine: skip when present, else fetch and check, then link into /usr/local/bin. */
function installLine(engine: CiEngine, version: string, options: CiInstallOptions, present?: string): string {
  const dir = ciEngineDir(engine, version, options.root);
  const install = `(set -e; ${fetchScript(engine, version, dir, recordedSums(engine, version, options.sha256))})`;
  const link = `ln -sf "${dir}/${engine}" /usr/local/bin/${engine}`;
  const inDir = `[ -x "${dir}/${engine}" ]`;
  return present ? `${present} || { { ${inDir} || ${install}; } && ${link}; }` : `{ ${inDir} || ${install}; } && ${link}`;
}

/**
 * Pulumi at `version` under `<root>/pulumi-<version>/`, checked against the
 * release checksums. Skips when the `pulumi` on PATH is that version.
 */
export function pulumiInstallLine(version = PULUMI_CI_VERSION, options: CiInstallOptions = {}): string {
  ciRelease("pulumi", version);
  const present = `{ command -v pulumi >/dev/null 2>&1 && [ "$(pulumi version 2>/dev/null)" = "v${version}" ]; }`;
  return installLine("pulumi", version, options, present);
}

/**
 * plunge at `version` under `<root>/plunge-<version>/`, its language hosts
 * beside it, checked against the release checksums. plunge reports the
 * Pulumi version it is built from, not its own release, so only the
 * versioned directory tells an installed release apart.
 */
export function plungeInstallLine(version = PLUNGE_CI_VERSION, options: CiInstallOptions = {}): string {
  return installLine("plunge", version, options);
}

/** The lines for the project at `dir`. */
export function pulumiCiSetup(ctx: { dir: string }): string[] {
  return [pulumiMemberEngine(ctx.dir).engine === "plunge" ? plungeInstallLine() : pulumiInstallLine()];
}
