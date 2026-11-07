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
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { NEXT_RELEASE } from "../release-floors";
import type { PublishDeclaration } from "./publish-declaration";
import type { Release, ReleaseArtifact } from "./release-store";

/** The variable that names the digests file a release's package build reads. */
export const RELEASE_DIGESTS_ENV = "CHANT_RELEASE_DIGESTS";

/** The first chant with `release.images`, `CHANT_RELEASE_DIGESTS`, `chant release images` and an npm target's `pins` (#4657). Products feature-detect on it. */
export const RELEASE_IMAGES_FLOOR = NEXT_RELEASE;

/** One image a release builds in its cut. */
export interface ReleaseImageDeclaration {
  /** The image's name: its key in the digests file, and its artifact's `component` in the release. */
  name: string;
  /** The shell command, run in the member's directory, that writes the archive. */
  build: string;
  /** The OCI archive the command writes, a layout directory or a tar file, relative to the member. The `oci` target's `image`. */
  archive: string;
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

/** Check a member's `release.images`: names valid and unique, archives inside the member. */
export function checkReleaseImages(images: readonly ReleaseImageDeclaration[]): void {
  const seen = new Set<string>();
  for (const i of images) {
    if (!NAME.test(i.name)) throw new ReleaseImageError("release-image-name-invalid", `release.images: "${i.name}" is not a name of letters, digits, ".", "_" and "-"`);
    if (seen.has(i.name)) throw new ReleaseImageError("release-image-name-taken", `release.images names "${i.name}" twice`);
    seen.add(i.name);
    if (isAbsolute(i.archive) || i.archive.split(/[\\/]/).includes("..")) {
      throw new ReleaseImageError("release-image-archive-outside", `release.images "${i.name}": the archive ${i.archive} is not a path inside the member`);
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
  /** Run one build command; the default runs it through the shell with its output on stderr. */
  run?: (command: string, o: { cwd: string; env: NodeJS.ProcessEnv }) => number | null;
}

const defaultRun = (command: string, o: { cwd: string; env: NodeJS.ProcessEnv }): number | null =>
  spawnSync(command, { cwd: o.cwd, env: o.env, shell: true, stdio: ["ignore", 2, 2] }).status;

/**
 * Build each image and return it as the release's image artifact. The
 * command runs with `SOURCE_DATE_EPOCH` and, for a cut with a label,
 * `CHANT_RELEASE_LABEL`; an archive it did not write, or a command that
 * fails, stops the cut.
 */
export function buildReleaseImages(i: BuildImagesInput): ReleaseArtifact[] {
  checkReleaseImages(i.images);
  const run = i.run ?? defaultRun;
  const out: ReleaseArtifact[] = [];
  for (const image of i.images) {
    const env: NodeJS.ProcessEnv = { ...(i.env ?? process.env), SOURCE_DATE_EPOCH: String(i.sourceDateEpoch) };
    delete env.CHANT_RELEASE_LABEL;
    if (i.label !== null) env.CHANT_RELEASE_LABEL = i.label;
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
