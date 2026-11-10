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
 *
 * `link: false` (#4814) installs a second release beside the linked one, for
 * a step that runs `<root>/<engine>-<version>/<engine>` itself (pulumi-up's
 * `engineVersion` and `engineRoot`): the line skips only when that directory
 * holds the binary, and never touches PATH. {@link ciFetchScript} is the
 * download and check alone, for an image build's `RUN` with the arch from
 * `$TARGETARCH` ({@link CI_DOCKER_ARCH}) and the checksums URL from a build
 * argument, so a tampered checksums file can be shown to fail the build.
 *
 * Since #4908 the download, the check and the recorded sums are
 * `@intentius/chant/ci-image`'s, the one copy every engine install uses:
 * {@link ciFetchScript} is `ciToolFetchScript` and {@link PINNED_SHA256} is
 * read from `CI_TOOL_SHA256`. This module keeps the Pulumi words (the x64
 * and arm64 archive names, the sums by them) and the install lines.
 */
import { CI_SETUP_UNLINKED_FLOOR } from "@intentius/chant/lexicon";
import { CI_TOOL_DOCKER_ARCH, CI_TOOL_JOB_ARCH, CI_TOOL_SHA256, ciToolFetchScript, ciToolRelease, ciToolSha256, type CiToolArch } from "@intentius/chant/ci-image";
import { pulumiMemberEngine } from "./member-engine";

/** The first chant with `link: false` and {@link ciFetchScript} (#4814). It is core's floor, so it freezes with chant's release. */
export const PULUMI_CI_SETUP_FLOOR: string = CI_SETUP_UNLINKED_FLOOR;

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

const TOOL_ARCH: Record<CiArch, CiToolArch> = { x64: "amd64", arm64: "arm64" };

/** One release's download: the base URL, the archive per architecture, and its checksums file. */
export interface CiRelease {
  base: string;
  archive(arch: CiArch): string;
  checksums: string;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ROOT = /^\/[A-Za-z0-9._/-]*$/;

/** The release of `engine` at `version`, as ci-image names it (#4908). A version is a plain semver, so it is safe on a shell line. */
export function ciRelease(engine: CiEngine, version: string): CiRelease {
  if (!VERSION.test(version)) throw new Error(`${engine} version ${JSON.stringify(version)} is not a release version such as 3.272.0`);
  const r = ciToolRelease(engine, version, "amd64");
  return {
    base: r.url.slice(0, r.url.lastIndexOf("/")),
    archive: (arch) => ciToolRelease(engine, version, TOOL_ARCH[arch]).asset,
    checksums: r.checksums!,
  };
}

/**
 * The sha256 of each recorded Linux archive, by its file name: ci-image's
 * `CI_TOOL_SHA256` for Pulumi and plunge (#4908), where a release's two
 * lines are added when a default version moves.
 */
export const PINNED_SHA256: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CI_TOOL_SHA256).flatMap(([key, sum]) => {
    const m = /^(pulumi|plunge)-(.+)-linux-(amd64|arm64)$/.exec(key);
    return m ? [[ciRelease(m[1] as CiEngine, m[2]!).archive(m[3] === "amd64" ? "x64" : "arm64"), sum]] : [];
  }),
);

/** What a caller may set on an install line. */
export interface CiInstallOptions {
  /** Where the versioned directories live. Default {@link CI_ENGINE_ROOT}. */
  root?: string;
  /** Recorded sums by architecture, in place of {@link PINNED_SHA256}'s for this release. */
  sha256?: Partial<Record<CiArch, string>>;
  /**
   * Link the binary into /usr/local/bin (default true). `false` (#4814)
   * leaves PATH alone and skips only on the versioned directory, for a pin
   * a step runs by its path.
   */
  link?: boolean;
}

/** Where one release of one engine lives after its line runs. */
export function ciEngineDir(engine: CiEngine, version: string, root = CI_ENGINE_ROOT): string {
  if (!ROOT.test(root)) throw new Error(`an engine root is an absolute path of letters, digits and ._/-, not ${JSON.stringify(root)}`);
  return `${root.replace(/\/+$/, "")}/${engine}-${version}`;
}

/** The caller's sums by ci-image's architecture names. */
function toolSums(given: Partial<Record<CiArch, string>> | undefined): Partial<Record<CiToolArch, string>> | undefined {
  if (!given) return undefined;
  const out: Partial<Record<CiToolArch, string>> = {};
  for (const arch of CI_ARCHES) if (given[arch] !== undefined) out[TOOL_ARCH[arch]] = given[arch];
  return out;
}

/** The recorded sums for `version`, by architecture: the caller's, else {@link PINNED_SHA256}'s. */
export function recordedSums(engine: CiEngine, version: string, given?: Partial<Record<CiArch, string>>): Partial<Record<CiArch, string>> {
  ciRelease(engine, version);
  const sums = ciToolSha256(engine, version, toolSums(given));
  const out: Partial<Record<CiArch, string>> = {};
  for (const arch of CI_ARCHES) if (sums[TOOL_ARCH[arch]] !== undefined) out[arch] = sums[TOOL_ARCH[arch]];
  return out;
}

/** A shell expression giving the job's architecture as x64 or arm64. */
export const CI_JOB_ARCH = `"$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"`;

/**
 * A shell expression giving a Docker build's target architecture
 * (`ARG TARGETARCH`) as x64 or arm64. Each case pattern opens with "(":
 * bash 3.2 (macOS sh) cannot parse a bare `arm64)` inside `$(...)`.
 */
export const CI_DOCKER_ARCH = `"$(case "$TARGETARCH" in (arm64) echo arm64 ;; (*) echo x64 ;; esac)"`;

/**
 * `arch`, an expression giving x64 or arm64, as ci-image's amd64 or arm64.
 * The two expressions here are ci-image's own; another is mapped in the
 * shell.
 */
function toolArch(arch: string | undefined): string {
  if (arch === undefined || arch === CI_JOB_ARCH) return CI_TOOL_JOB_ARCH;
  if (arch === CI_DOCKER_ARCH) return CI_TOOL_DOCKER_ARCH;
  return `"$(case ${arch} in (x64) echo amd64 ;; (*) echo ${arch} ;; esac)"`;
}

/** Where {@link ciFetchScript} puts a release and what it checks it against. */
export interface CiFetchOptions {
  /** The directory the archive unpacks into, an absolute path: `/out/opt/plywood/pulumi-3.272.0` in an image's fetch stage. */
  dir: string;
  /** A shell expression giving x64 or arm64. Default {@link CI_JOB_ARCH}; an image build passes {@link CI_DOCKER_ARCH}. */
  arch?: string;
  /** A shell word for the checksums file's URL, such as `"$CHECKSUMS_URL"`. Default the release's own. */
  checksumsUrl?: string;
  /** Recorded sums by architecture, in place of {@link PINNED_SHA256}'s for this release. */
  sha256?: Partial<Record<CiArch, string>>;
}

/**
 * Shell that downloads one release into `dir` and checks it against the
 * release's checksums file and, when recorded, the sum per architecture
 * (#4814): ci-image's `ciToolFetchScript` (#4908). Run it under `set -e`.
 * Both archives unpack a top directory named after the engine, which
 * `--strip-components=1` drops. `arch` and `checksumsUrl` go onto the line
 * as they are, so they are the caller's shell, never a value from outside.
 */
export function ciFetchScript(engine: CiEngine, version: string, options: CiFetchOptions): string {
  if (!ROOT.test(options.dir)) throw new Error(`a fetch directory is an absolute path of letters, digits and ._/-, not ${JSON.stringify(options.dir)}`);
  ciRelease(engine, version);
  const sha256 = toolSums(options.sha256);
  return ciToolFetchScript(engine, version, {
    dir: options.dir,
    arch: toolArch(options.arch),
    ...(sha256 ? { sha256 } : {}),
    ...(options.checksumsUrl !== undefined ? { checksumsUrl: options.checksumsUrl } : {}),
  });
}

/** The line for one engine: skip when present, else fetch and check, then link into /usr/local/bin unless `link` is false. */
function installLine(engine: CiEngine, version: string, options: CiInstallOptions, present?: string): string {
  const dir = ciEngineDir(engine, version, options.root);
  const install = `(set -e; ${ciFetchScript(engine, version, { dir, ...(options.sha256 ? { sha256: options.sha256 } : {}) })})`;
  // Unlinked: the versioned directory alone says whether this release is there.
  if (options.link === false) return `[ -x "${dir}/${engine}" ] || ${install}`;
  const link = `ln -sf "${dir}/${engine}" /usr/local/bin/${engine}`;
  const inDir = `[ -x "${dir}/${engine}" ]`;
  return present ? `${present} || { { ${inDir} || ${install}; } && ${link}; }` : `{ ${inDir} || ${install}; } && ${link}`;
}

/**
 * Pulumi at `version` under `<root>/pulumi-<version>/`, checked against the
 * release checksums. Linked, it skips when the `pulumi` on PATH is that
 * version; with `link: false` only when the versioned directory holds it.
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
