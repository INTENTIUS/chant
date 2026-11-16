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
 * - `{ name, goreleaser: { config?, dist?, types? } }`: the cut runs
 *   `goreleaser release --snapshot --clean --skip=publish`, so goreleaser
 *   builds and publishes nothing, checks that `<dist>/metadata.json` gives
 *   the release's label as the version (the config's
 *   `snapshot.version_template` is `{{ .Env.CHANT_RELEASE_LABEL }}`), and
 *   records the files `<dist>/artifacts.json` lists of `types`. chant's own
 *   targets publish them. The goreleaser run is `CHANT_GORELEASER` when set,
 *   which `chant release workflow` points at the version it pins
 *   (../goreleaser-pin.ts), else `goreleaser` on the PATH.
 * - `{ name, checksums, of? }`: a file of `<sha256>  <file name>` lines, as
 *   `sha256sum` writes and checks them, over the files of the entries `of`
 *   names (default: every entry before it).
 *
 * Each file is recorded in the release as an `asset` artifact whose
 * `component` is the entry's name, so a publish target that reads a file at
 * a recorded path refuses one whose digest differs
 * (`publish-artifact-digest-mismatch`, ./publish-targets.ts). A forge or
 * homebrew target names an entry's files with `artifact:<name>` in its
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

/** The first chant with `release.artifacts`, `chant release artifacts` and `artifact:<name>` in a forge or homebrew target's `assets` (#5151). */
export const RELEASE_ARTIFACTS_FLOOR = "0.124.101";

/** The variable naming the goreleaser binary the cut runs. */
export const GORELEASER_ENV = "CHANT_GORELEASER";

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

export type ReleaseArtifactDeclaration = ReleaseArtifactBuild | ReleaseArtifactGoreleaser | ReleaseArtifactChecksums;

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

const outside = (p: string): boolean => isAbsolute(p) || p.split(/[\\/]/).includes("..");
const isBuild = (a: ReleaseArtifactDeclaration): a is ReleaseArtifactBuild => "build" in a && a.build !== undefined;
const isGoreleaser = (a: ReleaseArtifactDeclaration): a is ReleaseArtifactGoreleaser => "goreleaser" in a && a.goreleaser !== undefined;
const isChecksums = (a: ReleaseArtifactDeclaration): a is ReleaseArtifactChecksums => "checksums" in a && a.checksums !== undefined;

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
export function checkReleaseArtifacts(artifacts: readonly ReleaseArtifactDeclaration[], o: { imageNames?: readonly string[] } = {}): void {
  const seen = new Set<string>();
  const where = (a: { name: string }) => `release.artifacts "${a.name}"`;
  const inside = (a: { name: string }, what: string, p: string | undefined) => {
    if (p !== undefined && outside(p)) throw new ReleaseArtifactError("release-artifact-outside", `${where(a)}: ${what} ${p} is not a path inside the member`);
  };
  for (const a of artifacts) {
    if (!NAME.test(a.name)) throw new ReleaseArtifactError("release-artifact-name-invalid", `release.artifacts: "${a.name}" is not a name of letters, digits, ".", "_" and "-"`);
    if (seen.has(a.name)) throw new ReleaseArtifactError("release-artifact-name-taken", `release.artifacts names "${a.name}" twice`);
    if (o.imageNames?.includes(a.name)) throw new ReleaseArtifactError("release-artifact-name-taken", `release.artifacts names "${a.name}", which release.images names too, and a release records each name once`, "Rename one of them.");
    const kinds = [isBuild(a), isGoreleaser(a), isChecksums(a)].filter(Boolean).length;
    if (kinds !== 1) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)} names ${kinds === 0 ? "none" : "more than one"} of build, goreleaser and checksums; name one`);
    if (isBuild(a)) {
      if (a.outputs.length === 0) throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)} names no outputs`);
      if (a.platforms !== undefined && (a.platforms.length === 0 || !a.platforms.every((p) => PLATFORM.test(p)) || new Set(a.platforms).size !== a.platforms.length)) {
        throw new ReleaseArtifactError("release-artifact-invalid", `${where(a)}: platforms is a list of distinct os/arch such as linux/amd64, not ${JSON.stringify(a.platforms)}`);
      }
      for (const out of a.outputs) {
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
  checkReleaseArtifacts(i.artifacts, { ...(i.imageNames ? { imageNames: i.imageNames } : {}) });
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
    if (isBuild(a)) {
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
        const status = run(a.build, { cwd: i.cwd, env });
        const on = platform !== null ? ` for ${platform}` : "";
        if (status !== 0) throw new ReleaseArtifactError("release-artifact-build-failed", `the build of artifact "${a.name}"${on} exited ${status ?? "with a signal"}: ${a.build}`);
        const written: string[] = [];
        for (const pattern of a.outputs) {
          const path = fill(pattern, values, `release.artifacts "${a.name}"`);
          const found = expandOutput(i.cwd, path);
          if (found.length === 0) throw new ReleaseArtifactError("release-artifact-no-output", `the build of artifact "${a.name}"${on} wrote no ${path}`, "Make the build write every file outputs names, or name the files it writes.");
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

// ── archives ───────────────────────────────────────────────────────────

interface ArchiveEntry {
  /** The path inside the archive. */
  name: string;
  abs: string;
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
    const data = readFileSync(e.abs);
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
    const data = readFileSync(e.abs);
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

/** Whether any entry is built by goreleaser, for the workflow's install step. */
export function usesGoreleaser(artifacts: readonly ReleaseArtifactDeclaration[]): boolean {
  return artifacts.some(isGoreleaser);
}

/** The `artifact:<name>` prefix a forge or homebrew target's `assets` names an entry's files with. */
export const ARTIFACT_REF = "artifact:";
