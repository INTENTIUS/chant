/**
 * Images a release builds in its cut, and the digests its package pins
 * (#4657, option 1).
 *
 * A package that pins container images by digest needs those digests when it
 * is packed, and they exist only once the images are built. So the cut builds
 * each image `release.images` declares first, as an OCI archive, and records
 * the archive's digest in the release as an image artifact. It writes the
 * digests to a file, `{ "<name>": "sha256:..." }`, and runs the build that
 * packs the package with {@link RELEASE_DIGESTS_ENV} naming that file. The
 * digest of an OCI archive is the digest of its top manifest, which is the
 * digest a registry serves once the archive is pushed by the `oci` target.
 *
 * The publish job builds the images again from the release's commit
 * (`chant release images`), with `SOURCE_DATE_EPOCH` set to the commit's
 * time as in the cut, and refuses an archive whose digest is not the one the
 * release records, so what is pushed is what the package pins. An image build
 * that writes the same archive twice is the requirement (#4657's thread has
 * the check against terragucci's Dockerfiles).
 *
 * An npm target's `pins` names the file in a package that carries the
 * digests. The publish plan and `chant release verify` read it and refuse a
 * digest the release does not record as an image.
 *
 * An entry may name a Dockerfile instead of a command (#4819): chant runs
 * the reproducible build itself ({@link releaseImageBuildCommand}), a
 * `docker-container` buildx builder writing an OCI archive with timestamps
 * rewritten from `SOURCE_DATE_EPOCH` and no attestations, for every
 * platform, with the entry's own build arguments (`args`, #4908). Its `prepare` command (the bundle the image carries, a packed
 * package) runs first with no digests file named, so the image is the same
 * in the cut and the publish job. A product's package build turns the
 * digests file and its `{ name: reference }` into the table it bakes in with
 * {@link releaseImagePins}, and writes the pins file with
 * {@link writeReleaseImagePins}. This module reaches only Node's built-ins at
 * run time, so a product's build script imports it under plain Node.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import type { PublishDeclaration } from "./publish-declaration";
import type { Release, ReleaseArtifact } from "./release-store";
import { NEXT_RELEASE } from "../release-floors";

/** The variable that names the digests file a release's package build reads. */
export const RELEASE_DIGESTS_ENV = "CHANT_RELEASE_DIGESTS";

/** The first chant with `release.images`, `CHANT_RELEASE_DIGESTS`, `chant release images` and an npm target's `pins` (#4657). Products feature-detect on it. */
export const RELEASE_IMAGES_FLOOR = "0.124.71";

/**
 * The first chant whose `release.images` takes a Dockerfile entry, with
 * `releaseImagePins` and `writeReleaseImagePins` for a product's package
 * build (#4819).
 */
export const RELEASE_IMAGE_DOCKERFILE_FLOOR = "0.124.78";

/** The first chant whose Dockerfile entry in `release.images` takes `args`, build arguments beside the two chant passes (#4908). */
export const RELEASE_IMAGE_ARGS_FLOOR = "0.124.88";

/**
 * The first chant whose Dockerfile entry takes `labels`, OCI labels on the
 * image, and `{label}` and `{version}` in `args` and `labels` values, and
 * whose image builds see `CHANT_RELEASE_VERSION`; and whose default archive
 * moves out of a goreleaser entry's `dist` (#5269).
 */
export const RELEASE_IMAGE_LABELS_FLOOR = NEXT_RELEASE;

/**
 * A registry an image's bases are pulled from that needs a login (#5457):
 * its host and the environment variables that hold a username and a
 * password or token, a static pair such as a registry's pull token. `chant
 * release workflow` logs in to it before the jobs build, on GitHub, GitLab
 * and Forgejo and in a train, and `chant release doctor` checks that both
 * variables are set (`image-pull-login`). The build itself runs `docker
 * buildx`, which uses whatever login the machine has.
 */
export interface ReleaseImagePull {
  /** The registry's host, such as `cgr.dev` or `registry.example.com:5000`, as `docker login` takes it. */
  registry: string;
  /** The variable holding the username. */
  usernameEnv: string;
  /** The variable holding the password or token. */
  passwordEnv: string;
}

/** The first chant whose `release.images` entries take `pull` (#5457). */
export const RELEASE_IMAGE_PULL_FLOOR = NEXT_RELEASE;

/** One image a release builds in its cut with a command of the product's. */
export interface ReleaseImageBuild {
  /** The image's name: its key in the digests file, and its artifact's `component` in the release. */
  name: string;
  /** The shell command, run in the member's directory, that writes the archive. */
  build: string;
  /** The OCI archive the command writes, a layout directory or a tar file, relative to the member. The `oci` target's `image`. */
  archive: string;
  /**
   * The platforms the command builds, such as `["linux/amd64", "linux/arm64"]`
   * (#4876). chant does not pass them to the command; `chant release workflow`
   * reads them to set up QEMU for those the runner can't run. Unset: none.
   */
  platforms?: string[];
  /** The registries the build pulls from that need a login (#5457). */
  pull?: ReleaseImagePull[];
}

/** One image chant builds from a Dockerfile (#4819). */
export interface ReleaseImageDockerfile {
  name: string;
  /** The Dockerfile, relative to the member. */
  dockerfile: string;
  /** The build context, relative to the member. Default `.`. */
  context?: string;
  /** The platforms the archive's image index holds. Default {@link RELEASE_IMAGE_PLATFORMS}. */
  platforms?: string[];
  /** Where the archive goes, relative to the member. Default `dist/images/<name>.tar`. */
  archive?: string;
  /** A command run once before the builds, with `CHANT_RELEASE_DIGESTS` unset: what the image copies in, such as the bundle or a packed package. */
  prepare?: string;
  /**
   * Build arguments beside `SOURCE_DATE_EPOCH` and `CHANT_RELEASE_LABEL`
   * (#4908), such as the packed package's file and the chant packages the
   * image installs beside it, as sql-yodeler's `release-image.sh` passed
   * them. `{label}` in a value is the release's label and `{version}` the
   * label from its first digit (#5269), such as `{ VERSION: "{version}" }`;
   * the rest is literal.
   */
  args?: Record<string, string>;
  /**
   * OCI labels on the image (#5269), such as
   * `{ "org.opencontainers.image.version": "{version}" }`, with the same
   * placeholders as `args`.
   */
  labels?: Record<string, string>;
  /** The registries its bases are pulled from that need a login (#5457). */
  pull?: ReleaseImagePull[];
}

/** One image a release builds in its cut. */
export type ReleaseImageDeclaration = ReleaseImageBuild | ReleaseImageDockerfile;

/** The platforms a Dockerfile entry builds by default. Building arm64 on amd64 needs QEMU's binfmt handlers. */
export const RELEASE_IMAGE_PLATFORMS: readonly string[] = ["linux/amd64", "linux/arm64"];

/** The buildx builder a Dockerfile entry builds with, created with the `docker-container` driver when missing: the default driver cannot rewrite timestamps in an OCI archive. */
export const RELEASE_IMAGE_BUILDER = "chant-release";

const PLATFORM = /^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-z0-9]+)?$/;

/** A word the shell reads as itself. */
const sh = (s: string): string => (/^[A-Za-z0-9_./:=,@+%-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

const isDockerfile = (i: ReleaseImageDeclaration): i is ReleaseImageDockerfile => "dockerfile" in i && i.dockerfile !== undefined;

const archiveOf = (i: ReleaseImageDeclaration): string => i.archive ?? `dist/images/${i.name}.tar`;

/** The placeholders an `args` or `labels` value takes (#5269), each the variable the build command reads. */
const PLACEHOLDERS: Record<string, string> = { "{label}": '"$CHANT_RELEASE_LABEL"', "{version}": '"$CHANT_RELEASE_VERSION"' };

/** `s` as one shell word, its `{label}` and `{version}` read from the build's environment (#5269). */
const word = (s: string): string =>
  s
    .split(/(\{label\}|\{version\})/)
    .filter((p) => p.length > 0)
    .map((p) => PLACEHOLDERS[p] ?? sh(p))
    .join("");

/**
 * The shell command a Dockerfile entry builds with (#4819), the one
 * terragucci's and plywood's `scripts/release-image.sh` ran: `--no-cache`,
 * no provenance or SBOM in the archive (chant attaches its own), the
 * `SOURCE_DATE_EPOCH` the cut sets passed as a build argument and used to
 * rewrite every timestamp, and every platform in one image index.
 */
export function releaseImageBuildCommand(i: ReleaseImageDockerfile, o: { versionArg?: boolean } = {}): string {
  const archive = archiveOf(i);
  const b = RELEASE_IMAGE_BUILDER;
  return [
    `{ docker buildx inspect ${b} >/dev/null 2>&1 || docker buildx create --name ${b} --driver docker-container >/dev/null; }`,
    `mkdir -p ${sh(posix.dirname(archive))}`,
    [
      `docker buildx build --builder ${b} --no-cache --platform ${sh((i.platforms ?? RELEASE_IMAGE_PLATFORMS).join(","))}`,
      `--provenance=false --sbom=false --build-arg SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH"${o.versionArg ? ' --build-arg CHANT_RELEASE_LABEL="$CHANT_RELEASE_LABEL"' : ""}${Object.entries(i.args ?? {})
        .map(([k, v]) => ` --build-arg ${word(`${k}=${v}`)}`)
        .join("")}${Object.entries(i.labels ?? {})
        .map(([k, v]) => ` --label ${word(`${k}=${v}`)}`)
        .join("")}`,
      `--output ${sh(`type=oci,dest=${archive},rewrite-timestamp=true`)} -f ${sh(i.dockerfile)} ${sh(i.context ?? ".")} >&2`,
    ].join(" "),
  ].join(" && ");
}

/** The archive of a Dockerfile entry that names none and whose default would be inside a goreleaser entry's `dist` (#5269). */
export const imageArchiveBesideGoreleaser = (name: string): string => `build/images/${name}.tar`;

/** `p` is `dir` or inside it, both relative to the member. */
const within = (p: string, dir: string): boolean => {
  const a = posix.normalize(p.replace(/\\/g, "/"));
  const d = posix.normalize(dir.replace(/\\/g, "/")).replace(/\/$/, "");
  return d === "." || a === d || a.startsWith(`${d}/`);
};

/** The `dist` directory of each goreleaser entry in `release.artifacts` (#5269). */
const goreleaserDists = (artifacts: readonly unknown[]): string[] =>
  artifacts.flatMap((a) => {
    const g = (a as { goreleaser?: { dist?: unknown } } | null)?.goreleaser;
    return g && typeof g === "object" ? [typeof g.dist === "string" ? g.dist : "dist"] : [];
  });

/**
 * A member's `release.images` with each archive placed (#5269). goreleaser
 * empties its `dist` (`--clean`) when it builds, after the images, so an
 * archive there would be gone before the cut records it: a Dockerfile entry
 * that names no archive, whose default `dist/images/<name>.tar` is inside a
 * goreleaser entry's `dist`, writes {@link imageArchiveBesideGoreleaser}
 * instead. An archive named inside it is left for
 * {@link checkImagesOutsideGoreleaser} to refuse.
 */
export function placeReleaseImages(images: readonly ReleaseImageDeclaration[], artifacts: readonly unknown[] = []): ReleaseImageDeclaration[] {
  const dists = goreleaserDists(artifacts);
  if (dists.length === 0) return [...images];
  return images.map((i) => (isDockerfile(i) && i.archive === undefined && dists.some((d) => within(archiveOf(i), d)) ? { ...i, archive: imageArchiveBesideGoreleaser(i.name) } : i));
}

/** Refuse an image archive inside a goreleaser entry's `dist` (#5269), which goreleaser empties after the images are built. */
export function checkImagesOutsideGoreleaser(images: readonly ReleaseImageDeclaration[], artifacts: readonly unknown[] = []): void {
  const dists = goreleaserDists(artifacts);
  for (const i of images) {
    const dist = dists.find((d) => within(archiveOf(i), d));
    if (dist === undefined) continue;
    throw new ReleaseImageError(
      "release-image-archive-in-dist",
      `release.images "${i.name}": the archive ${archiveOf(i)} is inside ${dist}, which goreleaser empties when it builds the release's files, after the images`,
      `Write it outside ${dist}, such as archive: "${imageArchiveBesideGoreleaser(i.name)}".`,
    );
  }
}

/** Each entry as a command and an archive: a Dockerfile entry's command is {@link releaseImageBuildCommand}, its archive the default when it names none. */
export function resolveReleaseImages(images: readonly ReleaseImageDeclaration[], o: { versionArg?: boolean } = {}): ReleaseImageBuild[] {
  return images.map((i) => (isDockerfile(i) ? { name: i.name, build: releaseImageBuildCommand(i, o), archive: archiveOf(i) } : i));
}

/**
 * Every platform the images build (#4876): a Dockerfile entry's, or
 * {@link RELEASE_IMAGE_PLATFORMS} when it names none, and a command entry's
 * `platforms`. Sorted, each once.
 */
export function releaseImagePlatforms(images: readonly ReleaseImageDeclaration[]): string[] {
  return [...new Set(images.flatMap((i) => (isDockerfile(i) ? (i.platforms ?? RELEASE_IMAGE_PLATFORMS) : (i.platforms ?? []))))].sort();
}

export class ReleaseImageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "ReleaseImageError";
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BUILD_ARG = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
/** A registry host, with an optional port: no scheme, no path. */
const REGISTRY_HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]+)?$/;
/** The build arguments chant passes itself, which an entry's `args` cannot set. */
const CHANT_BUILD_ARGS = ["SOURCE_DATE_EPOCH", "CHANT_RELEASE_LABEL"];

const outside = (p: string): boolean => isAbsolute(p) || p.split(/[\\/]/).includes("..");

/**
 * Check a member's `release.images`: names valid and unique, one of `build`
 * and `dockerfile`, the archive inside the member, platforms of the form
 * os/arch. The Dockerfile and the context, which the build only reads, may
 * leave the member with `..` (#5271), so a member at `release/<name>` builds
 * the repository root's Dockerfile.
 */
export function checkReleaseImages(images: readonly ReleaseImageDeclaration[]): void {
  const seen = new Set<string>();
  for (const i of images) {
    if (!NAME.test(i.name)) throw new ReleaseImageError("release-image-name-invalid", `release.images: "${i.name}" is not a name of letters, digits, ".", "_" and "-"`);
    if (seen.has(i.name)) throw new ReleaseImageError("release-image-name-taken", `release.images names "${i.name}" twice`);
    seen.add(i.name);
    if (isDockerfile(i) && "build" in i) throw new ReleaseImageError("release-image-invalid", `release.images "${i.name}" names a build command and a Dockerfile; chant builds a Dockerfile itself, so name one`);
    if (outside(archiveOf(i))) throw new ReleaseImageError("release-image-archive-outside", `release.images "${i.name}": the archive ${archiveOf(i)} is not a path inside the member`);
    if (isDockerfile(i)) {
      for (const [what, p] of [["the Dockerfile", i.dockerfile], ["the context", i.context]] as const) {
        if (p !== undefined && isAbsolute(p)) throw new ReleaseImageError("release-image-archive-outside", `release.images "${i.name}": ${what} ${p} is an absolute path; name it relative to the member`);
      }
    }
    for (const [k, v] of Object.entries((isDockerfile(i) && i.labels) || {})) {
      if (!LABEL_KEY.test(k)) throw new ReleaseImageError("release-image-invalid", `release.images "${i.name}": labels names ${JSON.stringify(k)}, which is not a label key such as org.opencontainers.image.version`);
      if (typeof v !== "string" || /[\r\n]/.test(v)) throw new ReleaseImageError("release-image-invalid", `release.images "${i.name}": labels.${k} is not a one-line string`);
    }
    for (const [k, v] of Object.entries((isDockerfile(i) && i.args) || {})) {
      if (!BUILD_ARG.test(k)) throw new ReleaseImageError("release-image-invalid", `release.images "${i.name}": args names ${JSON.stringify(k)}, which is not a build argument name`);
      if (CHANT_BUILD_ARGS.includes(k)) throw new ReleaseImageError("release-image-invalid", `release.images "${i.name}": args sets ${k}, which chant passes itself`);
      if (typeof v !== "string" || /[\r\n]/.test(v)) throw new ReleaseImageError("release-image-invalid", `release.images "${i.name}": args.${k} is not a one-line string`);
    }
    for (const p of i.pull ?? []) {
      if (!REGISTRY_HOST.test(p.registry)) throw new ReleaseImageError("release-image-invalid", `release.images "${i.name}": pull names ${JSON.stringify(p.registry)}, which is not a registry host such as cgr.dev or registry.example.com:5000`);
      for (const v of [p.usernameEnv, p.passwordEnv]) if (!BUILD_ARG.test(v)) throw new ReleaseImageError("release-image-invalid", `release.images "${i.name}": pull ${p.registry} names ${JSON.stringify(v)}, which is not an environment variable name`);
    }
    if (i.platforms !== undefined && (i.platforms.length === 0 || !i.platforms.every((p) => PLATFORM.test(p)))) {
      throw new ReleaseImageError("release-image-invalid", `release.images "${i.name}": platforms is a list of os/arch such as linux/amd64, not ${JSON.stringify(i.platforms)}`);
    }
  }
}

/** The digest of an OCI archive: its top manifest's, as `index.json` names it. */
export type ArchiveDigest = (abs: string) => string;

export interface BuildImagesInput {
  images: readonly ReleaseImageDeclaration[];
  /** The member's directory. */
  cwd: string;
  /** The commit's time in seconds, passed to each build as `SOURCE_DATE_EPOCH`. */
  sourceDateEpoch: number;
  label: string | null;
  env?: NodeJS.ProcessEnv;
  archiveDigest: ArchiveDigest;
  /**
   * `release.version` stamps the label (#4840): a Dockerfile entry gets it as
   * the build argument `CHANT_RELEASE_LABEL`, for the image's version label.
   */
  versionArg?: boolean;
  /** Run one build command; the default runs it through the shell with its output on stderr. */
  run?: (command: string, o: { cwd: string; env: NodeJS.ProcessEnv }) => number | null;
}

const defaultRun = (command: string, o: { cwd: string; env: NodeJS.ProcessEnv }): number | null =>
  spawnSync(command, { cwd: o.cwd, env: o.env, shell: true, stdio: ["ignore", 2, 2] }).status;

/**
 * Build each image and return it as the release's image artifact. The
 * command runs with `SOURCE_DATE_EPOCH` and, for a cut with a label,
 * `CHANT_RELEASE_LABEL` and `CHANT_RELEASE_VERSION` (the label from its
 * first digit, when it has one); an archive it did not write, or a command that
 * fails, stops the cut.
 */
export function buildReleaseImages(i: BuildImagesInput): ReleaseArtifact[] {
  checkReleaseImages(i.images);
  const run = i.run ?? defaultRun;
  const out: ReleaseArtifact[] = [];
  const envFor = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...(i.env ?? process.env), SOURCE_DATE_EPOCH: String(i.sourceDateEpoch) };
    delete env.CHANT_RELEASE_LABEL;
    delete env.CHANT_RELEASE_VERSION;
    if (i.label !== null) env.CHANT_RELEASE_LABEL = i.label;
    // #5269: the label from its first digit, for an entry's {version}.
    const at = i.label?.search(/\d/) ?? -1;
    if (i.label !== null && at >= 0) env.CHANT_RELEASE_VERSION = i.label.slice(at);
    return env;
  };
  // #4819: each prepare command once, before any build, with no digests file, as the image's contents are built in the cut and the publish job alike.
  const prepared = new Set<string>();
  for (const image of i.images) {
    if (!isDockerfile(image) || !image.prepare || prepared.has(image.prepare)) continue;
    prepared.add(image.prepare);
    const env = envFor();
    delete env[RELEASE_DIGESTS_ENV];
    const status = run(image.prepare, { cwd: i.cwd, env });
    if (status !== 0) throw new ReleaseImageError("release-image-build-failed", `the prepare command of image "${image.name}" exited ${status ?? "with a signal"}: ${image.prepare}`);
  }
  for (const image of resolveReleaseImages(i.images, i.versionArg ? { versionArg: true } : {})) {
    const env = envFor();
    const status = run(image.build, { cwd: i.cwd, env });
    if (status !== 0) throw new ReleaseImageError("release-image-build-failed", `the build of image "${image.name}" exited ${status ?? "with a signal"}: ${image.build}`);
    const abs = resolve(i.cwd, image.archive);
    if (!existsSync(abs)) throw new ReleaseImageError("release-image-no-archive", `the build of image "${image.name}" wrote no ${image.archive}`, "Make the command write the OCI archive at archive, such as docker buildx build --output type=oci,dest=<archive>,rewrite-timestamp=true.");
    out.push({ component: image.name, kind: "image", path: relative(i.cwd, abs).split("\\").join("/"), digest: i.archiveDigest(abs) });
  }
  return out;
}

/** The release's built images by name: every image artifact with a path, which a handed image (#4694) has not. */
export function releaseImageDigests(release: Pick<Release, "artifactDigests">, names?: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of release.artifactDigests) {
    if (a.kind !== "image") continue;
    if (names && !names.includes(a.component)) continue;
    out[a.component] = a.digest;
  }
  return out;
}

// ── a product's package build (#4819) ──────────────────────────────────

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export interface ReleaseImagePinsInput {
  /** Each image's name in `release.images`, to its reference at this version: `ghcr.io/intentius/plywood-pulumi:0.3.0-pulumi3.272.0`. */
  images: Record<string, string>;
  /** The package's version. A cut's label (`CHANT_RELEASE_LABEL`) must be it, as it is when `release.version` stamps the package (#4840). */
  version: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The digest table a release's package build bakes into its bundle: each
 * reference in `images` to the digest the cut recorded for its name, in
 * `images`' order. Undefined outside a release build (no
 * `CHANT_RELEASE_DIGESTS`), when a pipeline names the images by tag. Refuses
 * a label that is not the version and a name the digests file has no digest
 * for.
 */
export function releaseImagePins(i: ReleaseImagePinsInput): Record<string, string> | undefined {
  const env = i.env ?? process.env;
  const file = env[RELEASE_DIGESTS_ENV];
  if (!file) return undefined;
  const label = env.CHANT_RELEASE_LABEL;
  if (label && label !== i.version) {
    throw new ReleaseImageError("release-label-not-version", `the release is labelled ${label}, and the package is at ${i.version}`, `Set the package's version to ${label} on the default branch, then cut the merged commit.`);
  }
  const named = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  const table: Record<string, string> = {};
  for (const [name, reference] of Object.entries(i.images)) {
    const digest = named[name];
    if (typeof digest !== "string" || !SHA256.test(digest)) throw new ReleaseImageError("release-image-digest-missing", `${file} has no digest for the ${name} image, which the release builds`);
    table[reference] = digest;
  }
  return table;
}

/**
 * Write the pins file an npm target's `pins` names, once the bundle is
 * built: the table as JSON, after checking that every bundle in `bundles`
 * carries each digest. With no table (not a release build), remove the file,
 * so a package never ships a stale one.
 */
export function writeReleaseImagePins(table: Record<string, string> | undefined, o: { out: string; bundles?: readonly string[] }): void {
  if (!table) {
    rmSync(o.out, { force: true });
    return;
  }
  for (const bundle of o.bundles ?? []) {
    const text = readFileSync(bundle, "utf-8");
    for (const [reference, digest] of Object.entries(table)) {
      if (!text.includes(digest)) throw new ReleaseImageError("release-pin-not-bundled", `${bundle} does not carry ${reference}@${digest}`);
    }
  }
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, `${JSON.stringify(table, null, 2)}\n`);
}

/** Write the digests file a package build reads. */
export function writeReleaseDigests(file: string, digests: Record<string, string>): void {
  mkdirSync(dirname(file), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(digests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
}

const DIGEST = /sha256:[0-9a-f]{64}/g;

/** Every `sha256:` digest in a pins file's text. */
export function pinnedDigests(text: string): string[] {
  return [...new Set(text.match(DIGEST) ?? [])];
}

/** The digests in `text` that the release does not record as an image. */
export function unknownPins(text: string, release: Pick<Release, "artifactDigests">): string[] {
  const known = new Set(release.artifactDigests.filter((a) => a.kind === "image").map((a) => a.digest));
  return pinnedDigests(text).filter((d) => !known.has(d));
}

/** A pins file read from a package directory or a packed `.tgz`, or null when the package has none. */
export function readPins(abs: string, pins: string, isDirectory: boolean): string | null {
  if (isDirectory) {
    const file = resolve(abs, pins);
    return existsSync(file) ? readFileSync(file, "utf-8") : null;
  }
  const run = spawnSync("tar", ["-xzOf", abs, `package/${pins.replace(/^\.\//, "")}`], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  return run.status === 0 ? run.stdout : null;
}

/**
 * For `chant release verify` (#4657): the first package an npm target's
 * `pins` finds holding an image digest the release does not record, said in
 * a sentence, or null. A package not built here is not read.
 */
export function packagePinProblem(cwd: string, release: Pick<Release, "artifactDigests">, targets: readonly PublishDeclaration[]): string | null {
  for (const t of targets) {
    if (t.type !== "npm" || !t.pins) continue;
    for (const p of t.packages) {
      const abs = resolve(cwd, p);
      if (!existsSync(abs)) continue;
      const text = readPins(abs, t.pins, statSync(abs).isDirectory());
      const unknown = text === null ? [] : unknownPins(text, release);
      if (unknown.length > 0) return `${p} pins ${unknown.join(", ")} in ${t.pins}, which the release does not record as an image`;
    }
  }
  return null;
}

/** Each registry `images` pull from that needs a login, once, with the entries' variables (#5457). */
export function releaseImagePulls(images: readonly ReleaseImageDeclaration[]): ReleaseImagePull[] {
  const out = new Map<string, ReleaseImagePull>();
  for (const i of images) for (const p of i.pull ?? []) if (!out.has(p.registry)) out.set(p.registry, p);
  return [...out.values()].sort((a, b) => a.registry.localeCompare(b.registry));
}

/** The registries whose username or password variable is unset in `env`, with the variables missing. */
export function pullCredentialsMissing(images: readonly ReleaseImageDeclaration[], env: NodeJS.ProcessEnv): Array<{ registry: string; missing: string[] }> {
  return releaseImagePulls(images)
    .map((p) => ({ registry: p.registry, missing: [p.usernameEnv, p.passwordEnv].filter((v) => !env[v]) }))
    .filter((p) => p.missing.length > 0);
}
