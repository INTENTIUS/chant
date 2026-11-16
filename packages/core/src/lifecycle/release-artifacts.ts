/**
 * Files a release builds once, in its cut (#5151): binaries, archives of
 * them, a checksums file, or what goreleaser writes.
 *
 * `release.artifacts` in `chant.config.ts` lists them, in order:
 *
 * - `{ name, build, outputs, platforms?, archive? }`: the cut runs `build` in
 *   the member's directory, once, or once per platform with
 *   `CHANT_RELEASE_OS`, `CHANT_RELEASE_ARCH` and `CHANT_RELEASE_EXT` set
 *   (`.exe` on Windows, else empty), and records each file `outputs` names.
 *   An output may hold `{os}`, `{arch}`, `{ext}`, `{label}` and `{version}`,
 *   and `*` or `?` within a path segment. With `archive`, chant packs each
 *   platform's outputs, with `archive.files` beside them, into a tar.gz
 *   (a zip on Windows), and the release records the archives in place of
 *   the outputs. chant writes the archives itself, every entry dated
 *   `SOURCE_DATE_EPOCH` and owned by root, so the same files pack to the
 *   same bytes.
 * - `{ name, outputs, platforms?, archive?, builtBy? }`, with no `build`
 *   (#5183): files something else built, such as a `release.workflow.builds`
 *   job on another runner, whose archive the release workflow unpacks into
 *   the checkout before the cut. The cut runs nothing and records the files
 *   at `outputs`, per platform, packing them as above; one that is not there
 *   stops it (`release-artifact-not-built`). `builtBy` names the build jobs
 *   that write them, and `outputs` defaults to those jobs' outputs. Under
 *   `--at` the cut reads them from the checkout it runs in, which must be at
 *   the commit it cuts.
 * - `{ name, goreleaser: { config?, dist?, types? } }`: the cut runs
 *   `goreleaser release --snapshot --clean --skip=publish`, so goreleaser
 *   builds and publishes nothing, checks that `<dist>/metadata.json` gives
 *   the release's label as the version (the config's
 *   `snapshot.version_template` is `{{ .Env.CHANT_RELEASE_LABEL }}`), and
 *   records the files `<dist>/artifacts.json` lists of `types`. chant's own
 *   targets publish them. The goreleaser run is `CHANT_GORELEASER` when set,
 *   which `chant release workflow` points at the version it pins
 *   (../tool-pins.ts), else `goreleaser` on the PATH.
 * - `{ name, helm: { chart, dir?, appVersion? } }` (#5233): chant packs the
 *   Helm chart in the directory `chart` into `<dir>/<chart name>-<version>.tgz`
 *   itself, as `helm package` lays it out (the chart's files under a
 *   directory named for it, less what `.helmignore` and helm's own default
 *   leave out), with `version` in `Chart.yaml` set to the label from its first
 *   digit and, with `appVersion`, `appVersion` set to the label. Every entry is
 *   dated `SOURCE_DATE_EPOCH`, so the same chart packs to the same bytes. No
 *   helm is needed; a chart's dependencies are packed as they sit in its
 *   `charts/` directory.
 * - `{ name, nfpm: { config?, packagers?, platforms?, dir?, fileName? } }`
 *   (#5233): the cut runs nfpm once per packager (`deb` and `rpm` by default)
 *   and platform, with `CHANT_RELEASE_VERSION` (the label from its first
 *   digit), `CHANT_RELEASE_LABEL`, `CHANT_RELEASE_OS` and `CHANT_RELEASE_ARCH`
 *   set for the config to read, and records each package. The config's
 *   `version` must name `${CHANT_RELEASE_VERSION}` or `${CHANT_RELEASE_LABEL}`
 *   (`release-artifact-version-mismatch`). The nfpm run is `CHANT_NFPM` when
 *   set, which `chant release workflow` points at the version it pins
 *   (../tool-pins.ts), else `nfpm` on the PATH.
 * - `{ name, checksums, of? }`: a file of `<sha256>  <file name>` lines, as
 *   `sha256sum` writes and checks them, over the files of the entries `of`
 *   names (default: every entry before it).
 *
 * Each file is recorded in the release as an `asset` artifact whose
 * `component` is the entry's name, so a publish target that reads a file at
 * a recorded path refuses one whose digest differs
 * (`publish-artifact-digest-mismatch`, ./publish-targets.ts). A forge,
 * homebrew or index target names an entry's files with `artifact:<name>` in its
 * `assets`.
 *
 * A dispatched release workflow hands the files from the cut job to the
 * publish job, which checks them against the record (`chant release
 * artifacts --from`). A workflow on a release tag builds them again from
 * the release's commit (`chant release artifacts <label>`) and refuses a
 * file that differs, which needs builds that write the same bytes twice.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import type { Release, ReleaseArtifact } from "./release-store";
import { NEXT_RELEASE } from "../release-floors";
import { stampVersionFile } from "./release-version-formats";
import { parseYAML } from "../yaml";

/** The first chant with `release.artifacts`, `chant release artifacts` and `artifact:<name>` in a forge or homebrew target's `assets` (#5151). */
export const RELEASE_ARTIFACTS_FLOOR = "0.124.101";

/** The variable naming the goreleaser binary the cut runs. */
export const GORELEASER_ENV = "CHANT_GORELEASER";

/** The first chant with `helm` and `nfpm` entries in `release.artifacts` (#5233). */
export const RELEASE_ARTIFACTS_PACKAGES_FLOOR = NEXT_RELEASE;

/** The variable naming the nfpm binary the cut runs (#5233). */
export const NFPM_ENV = "CHANT_NFPM";

/** How an archive entry packs a platform's outputs. */
export interface ReleaseArchiveSpec {
  /** The archive's file name without its extension. May hold `{name}`, `{os}`, `{arch}`, `{label}` and `{version}`. Default `{name}_{os}_{arch}`, or `{name}` with no platforms. */
  name?: string;
  /** The directory the archives are written to, relative to the member. Default `dist`. */
  dir?: string;
  /** Files of the member packed beside the outputs at their own paths, such as `README.md` and `LICENSE`. */
  files?: string[];
  /** `tar.gz` or `zip`. Default `tar.gz`, and `zip` for a Windows platform. */
  format?: "tar.gz" | "zip";
}

/** Files a command of the product's builds. */
export interface ReleaseArtifactBuild {
  /** The entry's name: the `component` of each file it records, and what `artifact:<name>` and a checksums entry's `of` name. */
  name: string;
  /** The shell command, run in the member's directory, that writes the outputs. */
  build: string;
  /** The files it writes, relative to the member. */
  outputs: string[];
  /** The platforms, `os/arch`, to run `build` for, once each. */
  platforms?: string[];
  /** Pack each platform's outputs into an archive, recorded in their place. `true` takes every default. */
  archive?: ReleaseArchiveSpec | true;
}

/**
 * Files built before the cut, by something other than the cut (#5183): a
 * `release.workflow.builds` job on another runner, or a step before it. The
 * cut records the files at `outputs` as they are.
 */
export interface ReleaseArtifactPrebuilt {
  name: string;
  /** The files, relative to the member; the same placeholders and globs as a build's. Default: the outputs of the `builtBy` jobs, with no platforms. */
  outputs?: string[];
  /** The `release.workflow.builds` jobs that write the files, by name. */
  builtBy?: string | string[];
  /** The platforms, `os/arch`, the outputs are filled in for, once each. */
  platforms?: string[];
  /** Pack each platform's outputs into an archive, recorded in their place. */
  archive?: ReleaseArchiveSpec | true;
}

/** A `release.workflow.builds` job, as far as `builtBy` reads it. */
export interface ReleaseBuildJobRef {
  name: string;
  outputs: readonly string[];
}

/** Files goreleaser builds, in snapshot mode. */
export interface ReleaseArtifactGoreleaser {
  name: string;
  goreleaser: {
    /** The goreleaser config, relative to the member. Default: goreleaser's own search (`.goreleaser.yaml` and the rest). */
    config?: string;
    /** goreleaser's `dist` directory, relative to the member. Default `dist`. */
    dist?: string;
    /** The `type`s of `artifacts.json` entries to record. Default {@link GORELEASER_TYPES}. */
    types?: string[];
  };
}

/** A checksums file over other entries' files. */
export interface ReleaseArtifactChecksums {
  name: string;
  /** The file, relative to the member, such as `dist/SHA256SUMS` or `dist/checksums.txt`. */
  checksums: string;
  /** The entries it covers. Default: every entry before it. */
  of?: string[];
}

/** A Helm chart chant packs itself (#5233). */
export interface ReleaseArtifactHelm {
  name: string;
  helm: {
    /** The chart's directory, holding `Chart.yaml`, relative to the member. */
    chart: string;
    /** The directory the chart archive is written to, relative to the member. Default `dist`. */
    dir?: string;
    /** Set `appVersion` in the packed `Chart.yaml` to the release's label too. Default false. */
    appVersion?: boolean;
  };
}

/** The package formats an nfpm entry builds. */
export const NFPM_PACKAGERS = ["deb", "rpm", "apk", "archlinux", "ipk"] as const;
export type NfpmPackager = (typeof NFPM_PACKAGERS)[number];

/** Each packager's file extension. */
const NFPM_EXTENSIONS: Readonly<Record<NfpmPackager, string>> = { deb: "deb", rpm: "rpm", apk: "apk", archlinux: "pkg.tar.zst", ipk: "ipk" };

/** Linux packages nfpm builds from files the member has, such as an earlier entry's binaries (#5233). */
export interface ReleaseArtifactNfpm {
  name: string;
  nfpm: {
    /** The nfpm config, relative to the member. Default `nfpm.yaml`. */
    config?: string;
    /** The package formats. Default `["deb", "rpm"]`. */
    packagers?: NfpmPackager[];
    /** The platforms, `os/arch`, to package for, once each, with `CHANT_RELEASE_OS` and `CHANT_RELEASE_ARCH` set. Default: once, for the config's own `arch`. */
    platforms?: string[];
    /** The directory the packages are written to, relative to the member. Default `dist`. */
    dir?: string;
    /** Each package's file name without its extension: `{name}`, `{version}`, `{label}`, `{os}`, `{arch}` and `{packager}`. Default `{name}_{version}_{arch}`, or `{name}_{version}` with no platforms. */
    fileName?: string;
  };
}

export type ReleaseArtifactDeclaration = ReleaseArtifactBuild | ReleaseArtifactPrebuilt | ReleaseArtifactGoreleaser | ReleaseArtifactChecksums | ReleaseArtifactHelm | ReleaseArtifactNfpm;

/**
 * The `artifacts.json` types recorded from goreleaser by default: what its
 * own release would upload. A `Binary` is recorded only when it sits at the
 * top of `dist`, as goreleaser writes an uploadable binary; the binaries it
 * builds for archives sit in a directory per target.
 */
export const GORELEASER_TYPES: readonly string[] = ["Archive", "Binary", "Checksum", "File", "Linux Package", "SBOM", "Source"];

export class ReleaseArtifactError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "ReleaseArtifactError";
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PLATFORM = /^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-z0-9]+)?$/;
const PLACEHOLDER = /\{([a-z]+)\}/g;
const OUTPUT_KEYS = new Set(["os", "arch", "ext", "label", "version"]);
const ARCHIVE_KEYS = new Set(["name", "os", "arch", "label", "version"]);
const NFPM_NAME_KEYS = new Set(["name", "version", "label", "os", "arch", "packager"]);

const outside = (p: string): boolean => isAbsolute(p) || p.split(/[\\/]/).includes("..");
const isGoreleaser = (a: ReleaseArtifactDeclaration): a is ReleaseArtifactGoreleaser => "goreleaser" in a && a.goreleaser !== undefined;
const isChecksums = (a: ReleaseArtifactDeclaration): a is ReleaseArtifactChecksums => "checksums" in a && a.checksums !== undefined;
const isHelm = (a: ReleaseArtifactDeclaration): a is ReleaseArtifactHelm => "helm" in a && a.helm !== undefined;
const isNfpm = (a: ReleaseArtifactDeclaration): a is ReleaseArtifactNfpm => "nfpm" in a && a.nfpm !== undefined;
/** An entry of files at `outputs`: built by its command, or (#5183) with no command, built before the cut. */
const isFiles = (a: ReleaseArtifactDeclaration): a is ReleaseArtifactBuild | ReleaseArtifactPrebuilt =>
  ("build" in a && a.build !== undefined) || ("outputs" in a && a.outputs !== undefined) || ("builtBy" in a && a.builtBy !== undefined);
const commandOf = (a: ReleaseArtifactBuild | ReleaseArtifactPrebuilt): string | undefined => ("build" in a ? a.build : undefined);
const builtByOf = (a: ReleaseArtifactBuild | ReleaseArtifactPrebuilt): string[] => {
  const b = "builtBy" in a ? a.builtBy : undefined;
  return b === undefined ? [] : Array.isArray(b) ? b : [b];
};

/** Whether the cut records an entry's files as something else built them, with no command of its own (#5183). */
export function isPrebuilt(a: ReleaseArtifactDeclaration): a is ReleaseArtifactPrebuilt {
  return isFiles(a) && commandOf(a) === undefined;
}

/** An entry's outputs: its own, or the outputs of the build jobs `builtBy` names. */
function outputsOf(a: ReleaseArtifactBuild | ReleaseArtifactPrebuilt, builds: readonly ReleaseBuildJobRef[] | undefined): string[] {
  if (a.outputs !== undefined) return a.outputs;
  return builtByOf(a).flatMap((n) => builds?.find((b) => b.name === n)?.outputs ?? []);
}

/** The label from its first digit, as a formula's and goreleaser's version reads it: `v1.4.0` is `1.4.0`. */
export function labelVersion(label: string | null): string | null {
  const at = label?.search(/\d/) ?? -1;
  return label && at >= 0 ? label.slice(at) : null;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/**
 * Check `release.artifacts`: names valid and unique and not an image's, one
 * of `build`, `goreleaser` and `checksums`, paths inside the member,
 * platforms of the form os/arch, placeholders chant fills, and a checksums
 * entry's `of` naming entries before it.
 */
export function checkReleaseArtifacts(artifacts: readonly ReleaseArtifactDeclaration[], o: { imageNames?: readonly string[]; builds?: readonly ReleaseBuildJobRef[] } = {}): void {
  const seen = new Set<string>();
  const where = (a: { name: string }) => `release.artifacts "${a.name}"`;
  const inside = (a: { name: string }, what: string, p: string | undefined) => {
    if (p !== undefined && outside(p)) throw new ReleaseArtifactError("release-artifact-outside", `${where(a)}: ${what} ${p} is not a path inside the member`);
  };
  for (const a of artifacts) {
    if (!NAME.test(a.name)) throw new ReleaseArtifactError("release-artifact-name-invalid", `release.artifacts: "${a.name}" is not a name of letters, digits, ".", "_" and "-"`);
    if (seen.has(a.name)) throw new ReleaseArtifactError("release-artifact-name-taken", `release.artifacts names "${a.name}" twice`);
    if (o.imageNames?.includes(a.name)) throw new ReleaseArtifactError("release-artifact-name-taken", `release.artifacts names "${a.name}", which release.images names too, and a release records each name once`, "Rename one of them.");
    const kinds = [isFiles(a), isGoreleaser(a), isChecksums(a), isHelm(a), isNfpm(a)].filter(Boolean).length;
    if (kinds !== 1) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)} names ${kinds === 0 ? "none" : "more than one"} of outputs, goreleaser, helm, nfpm and checksums; name one`);
    if (isFiles(a)) {
      const jobs = builtByOf(a);
      if (jobs.length > 0 && commandOf(a) !== undefined) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)} names both a build command and builtBy; the cut runs the command, or records what the build jobs wrote`, "Leave out build to record the files the build jobs hand to the cut.");
      for (const j of jobs) {
        if (!o.builds?.some((b) => b.name === j)) {
          const known = (o.builds ?? []).map((b) => b.name);
          throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: builtBy names "${j}", which is not a release.workflow.builds job${known.length > 0 ? ` (they are ${known.join(", ")})` : ""}`, "Name a job of release.workflow.builds, or leave out builtBy and name the files in outputs.");
        }
      }
      if (a.outputs === undefined && jobs.length === 0) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)} names no outputs`);
      if (a.outputs === undefined && a.platforms !== undefined) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)} has platforms and no outputs; a build job's outputs name no platform`, "Name each platform's files in outputs with {os}, {arch} and {ext}.");
      const outputs = outputsOf(a, o.builds);
      if (outputs.length === 0) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)} names no outputs`);
      if (a.outputs === undefined) {
        const bracket = outputs.find((p) => /[[\]]/.test(p));
        if (bracket !== undefined) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: the build job's output ${bracket} uses a [ ] glob, which an artifact's outputs do not`, "Name the files in outputs, with * and ?.");
      }
      if (a.platforms !== undefined && (a.platforms.length === 0 || !a.platforms.every((p) => PLATFORM.test(p)) || new Set(a.platforms).size !== a.platforms.length)) {
        throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: platforms is a list of distinct os/arch such as linux/amd64, not ${JSON.stringify(a.platforms)}`);
      }
      for (const out of outputs) {
        inside(a, "the output", out);
        const unknown = placeholders(out).filter((k) => !OUTPUT_KEYS.has(k));
        if (unknown.length > 0) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: the output ${out} names {${unknown[0]}}; an output may hold {os}, {arch}, {ext}, {label} and {version}`);
        if (a.platforms === undefined && placeholders(out).some((k) => k === "os" || k === "arch" || k === "ext")) {
          throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: the output ${out} names a platform, and the entry has no platforms`);
        }
      }
      if (a.archive !== undefined && a.archive !== true) {
        inside(a, "the archive directory", a.archive.dir);
        for (const f of a.archive.files ?? []) {
          inside(a, "the archived file", f);
          if (/[*?]/.test(f)) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: archive.files names ${f}; name each file`);
        }
        if (a.archive.name !== undefined) {
          const unknown = placeholders(a.archive.name).filter((k) => !ARCHIVE_KEYS.has(k));
          if (unknown.length > 0 || /[\\/]/.test(a.archive.name)) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: archive.name ${a.archive.name} is not a file name holding {name}, {os}, {arch}, {label} and {version}`);
        }
        if (a.archive.format !== undefined && a.archive.format !== "tar.gz" && a.archive.format !== "zip") throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: archive.format is tar.gz or zip`);
      }
    } else if (isGoreleaser(a)) {
      inside(a, "the goreleaser config", a.goreleaser.config);
      inside(a, "the dist directory", a.goreleaser.dist);
      if (a.goreleaser.types !== undefined && a.goreleaser.types.length === 0) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: goreleaser.types is empty, so nothing would be recorded`);
    } else if (isHelm(a)) {
      inside(a, "the chart directory", a.helm.chart);
      inside(a, "the chart archive directory", a.helm.dir);
    } else if (isNfpm(a)) {
      inside(a, "the nfpm config", a.nfpm.config);
      inside(a, "the package directory", a.nfpm.dir);
      const packagers = a.nfpm.packagers;
      if (packagers !== undefined && (packagers.length === 0 || !packagers.every((p) => (NFPM_PACKAGERS as readonly string[]).includes(p)) || new Set(packagers).size !== packagers.length)) {
        throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: nfpm.packagers is a list of distinct ${NFPM_PACKAGERS.join(", ")}, not ${JSON.stringify(packagers)}`);
      }
      if (a.nfpm.platforms !== undefined && (a.nfpm.platforms.length === 0 || !a.nfpm.platforms.every((p) => PLATFORM.test(p)) || new Set(a.nfpm.platforms).size !== a.nfpm.platforms.length)) {
        throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: nfpm.platforms is a list of distinct os/arch such as linux/amd64, not ${JSON.stringify(a.nfpm.platforms)}`);
      }
      if (a.nfpm.fileName !== undefined) {
        const unknown = placeholders(a.nfpm.fileName).filter((k) => !NFPM_NAME_KEYS.has(k));
        if (unknown.length > 0 || /[\\/]/.test(a.nfpm.fileName)) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: nfpm.fileName ${a.nfpm.fileName} is not a file name holding {name}, {version}, {label}, {os}, {arch} and {packager}`);
        if (a.nfpm.platforms === undefined && placeholders(a.nfpm.fileName).some((k) => k === "os" || k === "arch")) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: nfpm.fileName ${a.nfpm.fileName} names a platform, and the entry has no platforms`);
      }
    } else if (isChecksums(a)) {
      inside(a, "the checksums file", a.checksums);
      for (const n of a.of ?? []) {
        if (!seen.has(n)) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: of names "${n}", which is not an entry before it`);
      }
    }
    seen.add(a.name);
  }
}

/** Every platform a Go-style `os/arch` names, with its Windows extension. */
function platformValues(platform: string): { os: string; arch: string; ext: string } {
  const [os, ...rest] = platform.split("/");
  return { os: os!, arch: rest.join("_"), ext: os === "windows" ? ".exe" : "" };
}

function fill(text: string, values: Record<string, string>, what: string): string {
  return text.replace(PLACEHOLDER, (m, k: string) => {
    const v = values[k];
    if (v === undefined) {
      if (k === "label" || k === "version") throw new ReleaseArtifactError("release-artifact-no-label", `${what} names {${k}}, and the cut has no label${k === "version" ? " with a digit" : ""}`, "Cut the release with a label such as v1.4.0.");
      return m;
    }
    return v;
  });
}

/** The files a path names, `*` and `?` matched within a segment, sorted. */
export function expandOutput(cwd: string, pattern: string): string[] {
  const parts = pattern.replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter((s) => s !== "" && s !== ".");
  let found = [""];
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    const next: string[] = [];
    for (const base of found) {
      if (!/[*?]/.test(part)) {
        const p = base ? `${base}/${part}` : part;
        if (existsSync(resolve(cwd, p))) next.push(p);
        continue;
      }
      const dir = resolve(cwd, base || ".");
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      const re = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
      for (const e of readdirSync(dir).sort()) if (re.test(e)) next.push(base ? `${base}/${e}` : e);
    }
    found = last ? next.filter((p) => statSync(resolve(cwd, p)).isFile()) : next.filter((p) => statSync(resolve(cwd, p)).isDirectory());
  }
  return found.sort();
}

export interface BuildArtifactsInput {
  artifacts: readonly ReleaseArtifactDeclaration[];
  /** The member's directory. */
  cwd: string;
  /** The commit's time in seconds: each build's `SOURCE_DATE_EPOCH`, and the time of every archive entry. */
  sourceDateEpoch: number;
  label: string | null;
  env?: NodeJS.ProcessEnv;
  /** Image names, which an entry may not take. */
  imageNames?: readonly string[];
  /** `release.workflow.builds`, which `builtBy` names (#5183). */
  builds?: readonly ReleaseBuildJobRef[];
  /**
   * Where the files of an entry with no command sit (#5183), when not in
   * `cwd`: the member's directory in the checkout the cut runs from, when it
   * builds in a checkout of another commit (`--at`). They are copied to the
   * same paths in `cwd`.
   */
  prebuiltFrom?: string;
  /** Run one command; the default runs it through the shell with its output on stderr. */
  run?: (command: string, o: { cwd: string; env: NodeJS.ProcessEnv }) => number | null;
}

const defaultRun = (command: string, o: { cwd: string; env: NodeJS.ProcessEnv }): number | null =>
  spawnSync(command, { cwd: o.cwd, env: o.env, shell: true, stdio: ["ignore", 2, 2] }).status;

const posixPath = (cwd: string, abs: string): string => relative(cwd, abs).split("\\").join("/");

/** `sha256:<hex>` of a file. */
function digestOf(abs: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
}

/**
 * Build every entry, in order, and return each file as the release's asset
 * artifact. A command that fails, an output it did not write, a goreleaser
 * version that is not the label, or two entries writing one path stops the
 * cut.
 */
export function buildReleaseArtifacts(i: BuildArtifactsInput): ReleaseArtifact[] {
  checkReleaseArtifacts(i.artifacts, { ...(i.imageNames ? { imageNames: i.imageNames } : {}), ...(i.builds ? { builds: i.builds } : {}) });
  const run = i.run ?? defaultRun;
  const version = labelVersion(i.label);
  const labelValues: Record<string, string> = { ...(i.label !== null ? { label: i.label } : {}), ...(version !== null ? { version } : {}) };
  const baseEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...(i.env ?? process.env), SOURCE_DATE_EPOCH: String(i.sourceDateEpoch) };
    for (const k of ["CHANT_RELEASE_LABEL", "CHANT_RELEASE_OS", "CHANT_RELEASE_ARCH", "CHANT_RELEASE_EXT"]) delete env[k];
    if (i.label !== null) env.CHANT_RELEASE_LABEL = i.label;
    return env;
  };
  const byEntry = new Map<string, ReleaseArtifact[]>();
  const owner = new Map<string, string>();
  const record = (entry: string, abs: string): ReleaseArtifact => {
    const path = posixPath(i.cwd, abs);
    if (path.startsWith("..") || isAbsolute(path)) throw new ReleaseArtifactError("release-artifact-outside", `release.artifacts "${entry}": ${abs} is not inside the member`);
    const prior = owner.get(path);
    if (prior !== undefined) throw new ReleaseArtifactError("release-artifact-output-taken", `release.artifacts "${entry}" writes ${path}, which ${prior === entry ? "it already wrote for another platform" : `"${prior}" wrote`}, and a release records each file once`);
    owner.set(path, entry);
    return { component: entry, kind: "asset", path, digest: digestOf(abs) };
  };
  const out: ReleaseArtifact[] = [];
  for (const a of i.artifacts) {
    const files: ReleaseArtifact[] = [];
    if (isFiles(a)) {
      const command = commandOf(a);
      const outputs = outputsOf(a, i.builds);
      for (const platform of a.platforms ?? [null]) {
        const env = baseEnv();
        const values: Record<string, string> = { ...labelValues };
        if (platform !== null) {
          const p = platformValues(platform);
          Object.assign(values, p);
          env.CHANT_RELEASE_OS = p.os;
          env.CHANT_RELEASE_ARCH = p.arch;
          env.CHANT_RELEASE_EXT = p.ext;
        }
        const on = platform !== null ? ` for ${platform}` : "";
        if (command !== undefined) {
          const status = run(command, { cwd: i.cwd, env });
          if (status !== 0) throw new ReleaseArtifactError("release-artifact-build-failed", `the build of artifact "${a.name}"${on} exited ${status ?? "with a signal"}: ${command}`);
        }
        // #5183: with no command, the files are read where something else left them, copied in first under --at.
        const from = command === undefined && i.prebuiltFrom !== undefined ? i.prebuiltFrom : i.cwd;
        const written: string[] = [];
        for (const pattern of outputs) {
          const path = fill(pattern, values, `release.artifacts "${a.name}"`);
          const found = expandOutput(from, path);
          if (found.length === 0) {
            if (command !== undefined) throw new ReleaseArtifactError("release-artifact-no-output", `the build of artifact "${a.name}"${on} wrote no ${path}`, "Make the build write every file outputs names, or name the files it writes.");
            const jobs = builtByOf(a);
            throw new ReleaseArtifactError(
              "release-artifact-not-built",
              `artifact "${a.name}"${on} has no ${path}: the entry has no build command, so the file must be there before the cut${jobs.length > 0 ? `, written by the build job${jobs.length > 1 ? "s" : ""} ${jobs.join(", ")}` : ""}`,
              jobs.length > 0 ? "Make the build job write every file outputs names, or name the files it writes." : "Build the file before the cut (a release.workflow.builds job, or a step before it), or give the entry a build command.",
            );
          }
          if (from !== i.cwd) copyArtifactFiles(found.map((f) => ({ path: f })), from, i.cwd);
          written.push(...found);
        }
        if (a.archive === undefined) {
          for (const w of written) files.push(record(a.name, resolve(i.cwd, w)));
          continue;
        }
        const spec = a.archive === true ? {} : a.archive;
        const format = spec.format ?? (values.os === "windows" ? "zip" : "tar.gz");
        const base = fill(spec.name ?? (platform !== null ? "{name}_{os}_{arch}" : "{name}"), { ...values, name: a.name }, `release.artifacts "${a.name}" archive.name`);
        const archive = resolve(i.cwd, spec.dir ?? "dist", `${base}.${format}`);
        const entries: ArchiveEntry[] = [
          ...written.map((w) => ({ name: posix.basename(w), abs: resolve(i.cwd, w) })),
          ...(spec.files ?? []).map((f) => {
            const abs = resolve(i.cwd, f);
            if (!existsSync(abs) || !statSync(abs).isFile()) throw new ReleaseArtifactError("release-artifact-no-output", `artifact "${a.name}" archives ${f}, which is not a file in the member`);
            return { name: f.replace(/\\/g, "/").replace(/^\.\//, ""), abs };
          }),
        ];
        const names = new Set<string>();
        for (const e of entries) {
          if (names.has(e.name)) throw new ReleaseArtifactError("release-artifact-output-taken", `artifact "${a.name}"${on} would put two files named ${e.name} in ${posixPath(i.cwd, archive)}`);
          names.add(e.name);
        }
        mkdirSync(dirname(archive), { recursive: true });
        writeFileSync(archive, format === "zip" ? zipArchive(entries, i.sourceDateEpoch) : tarGzArchive(entries, i.sourceDateEpoch));
        files.push(record(a.name, archive));
      }
    } else if (isGoreleaser(a)) {
      files.push(...goreleaserFiles(a, i, baseEnv(), run).map((abs) => record(a.name, abs)));
    } else if (isHelm(a)) {
      files.push(record(a.name, packHelmChart(a, i)));
    } else if (isNfpm(a)) {
      files.push(...nfpmFiles(a, i, baseEnv, run).map((abs) => record(a.name, abs)));
    } else if (isChecksums(a)) {
      const names = a.of ?? [...byEntry.keys()];
      const covered = names.flatMap((n) => byEntry.get(n) ?? []);
      const lines = new Map<string, string>();
      for (const c of covered) {
        const base = posix.basename(c.path);
        if (lines.has(base)) throw new ReleaseArtifactError("release-artifact-checksums-name-taken", `checksums "${a.name}" covers two files named ${base}, and a line names a file by its name`, "Name the entries whose files have distinct names in of.");
        lines.set(base, `${c.digest.slice("sha256:".length)}  ${base}`);
      }
      if (lines.size === 0) throw new ReleaseArtifactError("release-artifact-invalid", `checksums "${a.name}" covers no file`, "Declare it after the entries whose files it lists.");
      const abs = resolve(i.cwd, a.checksums);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `${[...lines.keys()].sort().map((k) => lines.get(k)).join("\n")}\n`);
      files.push(record(a.name, abs));
    }
    byEntry.set(a.name, files);
    out.push(...files);
  }
  return out;
}

/** Run goreleaser in snapshot mode and list the files it wrote that the entry records. */
function goreleaserFiles(a: ReleaseArtifactGoreleaser, i: BuildArtifactsInput, env: NodeJS.ProcessEnv, run: NonNullable<BuildArtifactsInput["run"]>): string[] {
  if (i.label === null) throw new ReleaseArtifactError("release-artifact-no-label", `artifact "${a.name}" is built by goreleaser, whose binaries carry the release's label as their version, and the cut has no label`, "Cut the release with a label such as v1.4.0.");
  const bin = env[GORELEASER_ENV] || "goreleaser";
  const command = [bin === "goreleaser" ? bin : shellWord(bin), "release", "--snapshot", "--clean", "--skip=publish", ...(a.goreleaser.config ? ["--config", shellWord(a.goreleaser.config)] : [])].join(" ");
  const status = run(command, { cwd: i.cwd, env });
  if (status !== 0) throw new ReleaseArtifactError("release-artifact-build-failed", `goreleaser for artifact "${a.name}" exited ${status ?? "with a signal"}: ${command}`);
  const dist = a.goreleaser.dist ?? "dist";
  const read = (file: string): unknown => {
    const abs = resolve(i.cwd, dist, file);
    if (!existsSync(abs)) throw new ReleaseArtifactError("release-artifact-no-output", `goreleaser for artifact "${a.name}" wrote no ${posix.join(dist, file)}`, `Set goreleaser.dist to the config's dist directory.`);
    return JSON.parse(readFileSync(abs, "utf-8"));
  };
  const meta = read("metadata.json") as { version?: unknown };
  const want = [i.label, labelVersion(i.label)].filter((v): v is string => v !== null);
  if (typeof meta.version !== "string" || !want.includes(meta.version)) {
    throw new ReleaseArtifactError(
      "release-artifact-version-mismatch",
      `goreleaser built artifact "${a.name}" as version ${JSON.stringify(meta.version ?? null)}, and the release is labelled ${i.label}, so its binaries would not carry the release's version`,
      'Set the snapshot version in the goreleaser config to the label chant passes: snapshot: { version_template: "{{ .Env.CHANT_RELEASE_LABEL }}" }.',
    );
  }
  const listed = read("artifacts.json");
  if (!Array.isArray(listed)) throw new ReleaseArtifactError("release-artifact-no-output", `${posix.join(dist, "artifacts.json")} is not a list`);
  const types = a.goreleaser.types ?? GORELEASER_TYPES;
  const distAbs = resolve(i.cwd, dist);
  const files: string[] = [];
  for (const e of listed as Array<{ type?: unknown; path?: unknown }>) {
    if (typeof e.type !== "string" || typeof e.path !== "string" || !types.includes(e.type)) continue;
    const abs = resolve(i.cwd, e.path);
    if (a.goreleaser.types === undefined && e.type === "Binary" && dirname(abs) !== distAbs) continue;
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    if (!files.includes(abs)) files.push(abs);
  }
  if (files.length === 0) throw new ReleaseArtifactError("release-artifact-no-output", `goreleaser for artifact "${a.name}" listed no file of the types ${types.join(", ")}`);
  return files.sort();
}

const shellWord = (s: string): string => (/^[A-Za-z0-9_./:=,@+%-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

// ── Helm charts and Linux packages (#5233) ─────────────────────────────

/** Helm's ignore rules: a `.helmignore`'s lines and helm's default, `templates/.?*`. */
interface HelmIgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
  /** No `/` in the pattern: it matches a path's last segment. */
  base: boolean;
}

/** A `filepath.Match` pattern as a regular expression: `*` and `?` within a segment, `[...]` a class. */
function globSegmentRe(pattern: string): RegExp {
  let out = "";
  for (let k = 0; k < pattern.length; k++) {
    const c = pattern[k]!;
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "\\" && k + 1 < pattern.length) out += `\\${pattern[++k]}`;
    else if (c === "[") {
      const end = pattern.indexOf("]", k + 1);
      if (end < 0) out += "\\[";
      else {
        out += `[${pattern.slice(k + 1, end).replace(/\\/g, "\\\\")}]`;
        k = end;
      }
    } else out += c.replace(/[.+^${}()|\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** The rules of a `.helmignore`, after helm's default. A `**` is refused, as helm refuses it. */
export function helmIgnoreRules(text: string | null, where: string): HelmIgnoreRule[] {
  const rules: HelmIgnoreRule[] = [];
  for (const raw of ["templates/.?*", ...(text ?? "").split(/\r?\n/)]) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.includes("**")) throw new ReleaseArtifactError("release-artifact-invalid", `${where}: .helmignore has ${line}, and helm does not read **`, "Name the paths with * and ?, as helm does.");
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.replace(/\/+$/, "");
    line = line.replace(/^\//, "");
    if (line === "") continue;
    rules.push({ re: globSegmentRe(line), negate, dirOnly, base: !line.includes("/") });
  }
  return rules;
}

/** Whether helm leaves `rel` (a path from the chart's directory) out of the chart, as its ignore package decides. */
export function helmIgnored(rules: readonly HelmIgnoreRule[], rel: string, dir: boolean): boolean {
  const name = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
  for (const r of rules) {
    if (r.dirOnly && !dir) continue;
    const hit = r.re.test(r.base ? name : rel);
    if (r.negate ? !hit : hit) return true;
  }
  return false;
}

/** Every file of the chart at `abs` that helm packs, from the chart's directory, sorted, `Chart.yaml` first. */
function helmChartFiles(abs: string, rules: readonly HelmIgnoreRule[]): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(rel ? resolve(abs, rel) : abs).sort()) {
      const p = rel ? `${rel}/${e}` : e;
      const st = statSync(resolve(abs, p));
      if (helmIgnored(rules, p, st.isDirectory())) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(p);
    }
  };
  walk("");
  return [...out.filter((p) => p === "Chart.yaml"), ...out.filter((p) => p !== "Chart.yaml")];
}

/** Pack a `helm` entry's chart into `<dir>/<name>-<version>.tgz`, as `helm package --version` would, every entry dated `SOURCE_DATE_EPOCH`. Returns the archive. */
function packHelmChart(a: ReleaseArtifactHelm, i: BuildArtifactsInput): string {
  const where = `release.artifacts "${a.name}"`;
  const version = labelVersion(i.label);
  if (i.label === null || version === null) throw new ReleaseArtifactError("release-artifact-no-label", `${where} packs a Helm chart, whose version is the release's label from its first digit, and the cut has ${i.label === null ? "no label" : `the label ${i.label}, which has no digit`}`, "Cut the release with a label such as v1.4.0.");
  const dir = resolve(i.cwd, a.helm.chart);
  const chartFile = resolve(dir, "Chart.yaml");
  if (!existsSync(chartFile)) throw new ReleaseArtifactError("release-artifact-no-output", `${where}: ${posix.join(a.helm.chart, "Chart.yaml")} does not exist, so ${a.helm.chart} is not a Helm chart`, "Set helm.chart to the directory that holds the chart's Chart.yaml.");
  const text = readFileSync(chartFile, "utf-8");
  let name: unknown;
  try {
    name = (parseYAML(text) as { name?: unknown }).name;
  } catch (err) {
    throw new ReleaseArtifactError("release-artifact-invalid", `${where}: ${posix.join(a.helm.chart, "Chart.yaml")} is not YAML chant can read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new ReleaseArtifactError("release-artifact-invalid", `${where}: ${posix.join(a.helm.chart, "Chart.yaml")} names no chart name helm takes`, "Give the chart a name of letters, digits, '.', '_' and '-'.");
  let chart: string;
  try {
    chart = stampVersionFile({ path: "Chart.yaml", field: "version" }, text, version);
    if (a.helm.appVersion) chart = stampVersionFile({ path: "Chart.yaml", field: "appVersion" }, chart, i.label);
  } catch (err) {
    const e = err as { message?: string; fix?: string };
    throw new ReleaseArtifactError("release-artifact-invalid", `${where}: ${e.message ?? String(err)}`, e.fix);
  }
  const ignore = existsSync(resolve(dir, ".helmignore")) ? readFileSync(resolve(dir, ".helmignore"), "utf-8") : null;
  const files = helmChartFiles(dir, helmIgnoreRules(ignore, where));
  const entries: ArchiveEntry[] = files.map((f) => ({ name: `${name}/${f}`, abs: resolve(dir, f), ...(f === "Chart.yaml" ? { bytes: Buffer.from(chart, "utf-8") } : {}) }));
  const archive = resolve(i.cwd, a.helm.dir ?? "dist", `${name}-${version}.tgz`);
  mkdirSync(dirname(archive), { recursive: true });
  writeFileSync(archive, tarGzArchive(entries, i.sourceDateEpoch));
  return archive;
}

/** The top-level `version` of an nfpm config, unquoted, or null. */
export function nfpmConfigVersion(text: string): string | null {
  const m = /^version:[ \t]*(.*?)[ \t]*(?:#.*)?$/m.exec(text);
  if (!m) return null;
  return m[1]!.replace(/^(["'])(.*)\1$/, "$2");
}

/** Whether an nfpm config's version carries the release's: it names the variable chant sets, or is the label or its version. */
export function nfpmVersionFollowsLabel(version: string | null, label: string, labelVer: string): boolean {
  if (version === null) return false;
  return /\$\{?CHANT_RELEASE_(VERSION|LABEL)\}?/.test(version) || version === label || version === labelVer;
}

/** Run nfpm for each platform and packager of an `nfpm` entry and list the packages it wrote. */
function nfpmFiles(a: ReleaseArtifactNfpm, i: BuildArtifactsInput, baseEnv: () => NodeJS.ProcessEnv, run: NonNullable<BuildArtifactsInput["run"]>): string[] {
  const where = `release.artifacts "${a.name}"`;
  const version = labelVersion(i.label);
  if (i.label === null || version === null) throw new ReleaseArtifactError("release-artifact-no-label", `${where} is packaged by nfpm, whose packages carry the release's label as their version, and the cut has ${i.label === null ? "no label" : `the label ${i.label}, which has no digit`}`, "Cut the release with a label such as v1.4.0.");
  const config = a.nfpm.config ?? "nfpm.yaml";
  const configAbs = resolve(i.cwd, config);
  if (!existsSync(configAbs)) throw new ReleaseArtifactError("release-artifact-no-output", `${where}: the nfpm config ${config} does not exist`, "Set nfpm.config to the member's nfpm config.");
  const declared = nfpmConfigVersion(readFileSync(configAbs, "utf-8"));
  if (!nfpmVersionFollowsLabel(declared, i.label, version)) {
    throw new ReleaseArtifactError(
      "release-artifact-version-mismatch",
      `${where}: ${config} gives the packages the version ${JSON.stringify(declared)}, and the release is labelled ${i.label}, so they would not carry the release's version`,
      'Set the version in the nfpm config to the one chant passes: version: "${CHANT_RELEASE_VERSION}".',
    );
  }
  const env0 = baseEnv();
  const bin = env0[NFPM_ENV] || "nfpm";
  const files: string[] = [];
  for (const platform of a.nfpm.platforms ?? [null]) {
    for (const packager of a.nfpm.packagers ?? (["deb", "rpm"] as NfpmPackager[])) {
      const env = baseEnv();
      env.CHANT_RELEASE_VERSION = version;
      const values: Record<string, string> = { name: a.name, label: i.label, version, packager };
      if (platform !== null) {
        const p = platformValues(platform);
        Object.assign(values, { os: p.os, arch: p.arch });
        env.CHANT_RELEASE_OS = p.os;
        env.CHANT_RELEASE_ARCH = p.arch;
        env.CHANT_RELEASE_EXT = p.ext;
      }
      const base = fill(a.nfpm.fileName ?? (platform !== null ? "{name}_{version}_{arch}" : "{name}_{version}"), values, `${where} nfpm.fileName`);
      const target = posix.join((a.nfpm.dir ?? "dist").replace(/\\/g, "/"), `${base}.${NFPM_EXTENSIONS[packager]}`);
      mkdirSync(dirname(resolve(i.cwd, target)), { recursive: true });
      const command = [bin === "nfpm" ? bin : shellWord(bin), "package", "--config", shellWord(config), "--packager", packager, "--target", shellWord(target)].join(" ");
      const on = `${packager}${platform !== null ? ` for ${platform}` : ""}`;
      const status = run(command, { cwd: i.cwd, env });
      if (status !== 0) throw new ReleaseArtifactError("release-artifact-build-failed", `nfpm for artifact "${a.name}" (${on}) exited ${status ?? "with a signal"}: ${command}`);
      const abs = resolve(i.cwd, target);
      if (!existsSync(abs) || !statSync(abs).isFile()) throw new ReleaseArtifactError("release-artifact-no-output", `nfpm for artifact "${a.name}" (${on}) wrote no ${target}`);
      files.push(abs);
    }
  }
  return files;
}

// ── archives ───────────────────────────────────────────────────────────

interface ArchiveEntry {
  /** The path inside the archive. */
  name: string;
  abs: string;
  /** The entry's bytes, in place of the file's (its mode is still the file's), such as a chart's `Chart.yaml` with its version set (#5233). */
  bytes?: Buffer;
}

const modeOf = (abs: string): number => (statSync(abs).mode & 0o111 ? 0o755 : 0o644);

function tarHeader(name: string, size: number, mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(512);
  let path = name;
  let prefix = "";
  if (Buffer.byteLength(path) > 100) {
    const cut = path.lastIndexOf("/", path.length - 1);
    prefix = cut > 0 ? path.slice(0, cut) : "";
    path = cut > 0 ? path.slice(cut + 1) : path;
    if (Buffer.byteLength(path) > 100 || Buffer.byteLength(prefix) > 155) throw new ReleaseArtifactError("release-artifact-invalid", `${name} is too long a path for an archive entry`);
  }
  const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, "0") + "\0";
  h.write(path, 0, 100, "utf-8");
  h.write(octal(mode, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii");
  h.write(octal(0, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(mtime, 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write("0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  h.write(prefix, 345, 155, "utf-8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

/** A gzipped ustar archive of the entries in order, each dated `mtime`, owned by uid and gid 0 and mode 0755 when executable, else 0644. */
export function tarGzArchive(entries: readonly ArchiveEntry[], mtime: number): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = e.bytes ?? readFileSync(e.abs);
    parts.push(tarHeader(e.name, data.length, modeOf(e.abs), mtime), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const gz = gzipSync(Buffer.concat(parts), { level: 9 });
  // The header's time is zero, and its OS byte is set to Unix so a macOS and a Linux zlib write the same bytes.
  gz.writeUInt32LE(0, 4);
  gz[9] = 3;
  return gz;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(epoch: number): { time: number; date: number } {
  const d = new Date(Math.max(epoch, 315532800) * 1000);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** A zip of the entries in order, deflated, each dated `mtime` (UTC) with its Unix mode. */
export function zipArchive(entries: readonly ArchiveEntry[], mtime: number): Buffer {
  const { time, date } = dosTime(mtime);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.bytes ?? readFileSync(e.abs);
    const packed = deflateRawSync(data, { level: 9 });
    const name = Buffer.from(e.name, "utf-8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((0o100000 | modeOf(e.abs)) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    central.push(c, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// ── the release's files ────────────────────────────────────────────────

/** The files the release records for `names`, the entries `release.artifacts` declares. */
export function releaseArtifactFiles(release: Pick<Release, "artifactDigests">, names: readonly string[]): ReleaseArtifact[] {
  return release.artifactDigests.filter((a) => a.kind === "asset" && names.includes(a.component));
}

/** Where a recorded file differs from the release in `cwd`: missing, or another digest. */
export function artifactFileProblems(cwd: string, files: readonly ReleaseArtifact[]): Array<{ path: string; problem: "missing" | "digest"; digest?: string; recorded: string }> {
  const out: ReturnType<typeof artifactFileProblems> = [];
  for (const f of files) {
    const abs = resolve(cwd, f.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      out.push({ path: f.path, problem: "missing", recorded: f.digest });
      continue;
    }
    const digest = digestOf(abs);
    if (digest !== f.digest) out.push({ path: f.path, problem: "digest", digest, recorded: f.digest });
  }
  return out;
}

/** Copy each file from `from` to the same path under `to`. A file missing from `from` is refused. */
export function copyArtifactFiles(files: readonly { path: string }[], from: string, to: string, o: { missingOk?: boolean } = {}): void {
  for (const f of files) {
    const src = resolve(from, f.path);
    if (!existsSync(src)) {
      if (o.missingOk) continue;
      throw new ReleaseArtifactError("release-artifact-missing", `${f.path} is not in ${from}`, "Hand the job the files the cut staged, or build them again: chant release artifacts <label>.");
    }
    const dest = resolve(to, f.path);
    if (dest === src) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

/** Whether any entry is packaged by nfpm, for the workflow's install step (#5233). */
export function usesNfpm(artifacts: readonly ReleaseArtifactDeclaration[]): boolean {
  return artifacts.some(isNfpm);
}

/** Whether any entry is built by goreleaser, for the workflow's install step. */
export function usesGoreleaser(artifacts: readonly ReleaseArtifactDeclaration[]): boolean {
  return artifacts.some(isGoreleaser);
}

/** The `artifact:<name>` prefix a forge, homebrew or index target's `assets` names an entry's files with. */
export const ARTIFACT_REF = "artifact:";
