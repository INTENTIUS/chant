/**
 * The container images the workflows chant generates run, and the Chainguard
 * bases of a product's CI image (`base: "chainguard"` in
 * `@intentius/chant/ci-image`, #5445), each pinned by the digest of its image
 * index (#4941), as {@link ../action-pins.ts} pins the actions by commit. A
 * tag can move; a digest cannot. A generator takes its image reference from
 * here, so an update is one change to this table. Each row names the tag it
 * followed when it was resolved, which the reference keeps beside the digest
 * so a reader sees the release. The Debian bases of a product's CI image stay
 * in `CI_BASE_IMAGES` in `ci-image.ts`. The Wolfi packages a Chainguard CI
 * image installs are pinned here too, by version ({@link WOLFI_PACKAGE_PINS}).
 *
 * Refresh every row with `chant release images --repin
 * packages/core/src/image-pins.ts` (#5457), which resolves each row's tag to
 * the index digest it names today and rewrites the digest, or one row by hand:
 *
 *   docker buildx imagetools inspect tonistiigi/binfmt:qemu-v10.2.3 --format '{{.Manifest.Digest}}'
 */

export interface ImagePin {
  /** The repository, as `docker run` names it: `tonistiigi/binfmt`. */
  readonly repository: string;
  /** The tag the row followed when it was resolved. */
  readonly tag: string;
  /** The image index digest, `sha256:<hex>`. */
  readonly digest: string;
}

const pin = (repository: string, tag: string, digest: string): ImagePin => ({ repository, tag, digest });

export const IMAGE_PINS = {
  // #4941: the GitLab release workflow's QEMU binfmt setup (#4876); `latest` pointed at this index on 2026-11-10.
  binfmt: pin("tonistiigi/binfmt", "qemu-v10.2.3", "sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0"),
  // #5445: the final stage of a product's CI image under `base: "chainguard"`. `latest-dev` pointed at this index on
  // 2026-11-21, built 2026-11-19, carrying Node 26.13.1 (nodejs-26), npm 12.2.3, git 2.56.1 and bash 5.3, running as 65532.
  chainguardNode: pin("cgr.dev/chainguard/node", "latest-dev", "sha256:cd993dc8ec644f8f35e8356f6b442e807cdc5e42f303da5ce19a55d7cf660b51"),
  // #5445: the fetch stage under `base: "chainguard"`; `latest` pointed at this index on 2026-11-21, running as root.
  chainguardWolfiBase: pin("cgr.dev/chainguard/wolfi-base", "latest", "sha256:be019c1c74fe69204a42c4e10bc4d886a49bf5403ffa74374ef7baa408fc9a26"),
} as const satisfies Record<string, ImagePin>;

/** The reference a pin is run by: `<repository>:<tag>@<digest>`. Docker pulls by the digest and ignores the tag. */
export const imageRef = (p: ImagePin): string => `${p.repository}:${p.tag}@${p.digest}`;

/** One Wolfi package at an exact version, with the day the version was read from Wolfi's index. */
export interface ApkPin {
  /** The version with its package revision, as `apk add <name>=<version>` takes it: `2.56.1-r1`. */
  readonly version: string;
  /** The day the version was read, `yyyy-mm-dd`. */
  readonly read: string;
}

const apk = (name: string, version: string, read: string): [string, ApkPin] => [name, { version, read }];

/**
 * The version of each Wolfi package a Chainguard CI image installs by default
 * (#5445): git and ca-certificates in the final stage, ca-certificates, curl
 * and unzip in the fetch stage, and each Wolfi name in
 * `CI_IMAGE_PACKAGE_NAMES`. The bases are pinned by digest, but Wolfi's
 * index is live, so without these the packages an image installs could
 * change between two builds of one commit. The generated Dockerfile writes
 * `apk add --no-cache <name>=<version> ...`.
 *
 * Each version is the newest one Wolfi's x86_64 and aarch64 indexes
 * (https://packages.wolfi.dev/os/<arch>/APKINDEX.tar.gz) both listed on the
 * day read, so one line builds both architectures. Only these packages are
 * held: their dependencies are named by soname, not version, and apk
 * resolves them against the index on the day of the build. Wolfi removes
 * versions at times, and a build then fails at `apk add`.
 *
 * `chant release images --repin packages/core/src/image-pins.ts` moves each
 * row to the newest version both indexes list today and writes today's date
 * on the rows it moved.
 */
export const WOLFI_PACKAGE_PINS: Readonly<Record<string, ApkPin>> = Object.fromEntries([
  apk("bash", "5.3-r14", "2026-11-21"),
  apk("bind-tools", "9.20.31-r0", "2026-11-21"),
  apk("bzip2", "1.0.8-r31", "2026-11-21"),
  apk("ca-certificates", "20261020-r0", "2026-11-21"),
  apk("coreutils", "9.12-r8", "2026-11-21"),
  apk("curl", "8.23.0-r4", "2026-11-21"),
  apk("diffutils", "3.12-r11", "2026-11-21"),
  apk("file", "5.48-r4", "2026-11-21"),
  apk("findutils", "4.11.0-r6", "2026-11-21"),
  apk("gawk", "5.4.2-r1", "2026-11-21"),
  apk("git", "2.56.1-r1", "2026-11-21"),
  apk("git-lfs", "3.8.1-r3", "2026-11-21"),
  apk("gnupg", "2.4.9-r13", "2026-11-21"),
  apk("gnutar", "1.35-r16", "2026-11-21"),
  apk("grep", "3.12-r12", "2026-11-21"),
  apk("gzip", "1.15-r3", "2026-11-21"),
  apk("iproute2", "7.3.0-r1", "2026-11-21"),
  apk("jq", "1.8.2-r5", "2026-11-21"),
  apk("less", "713-r0", "2026-11-21"),
  apk("make", "4.4.1-r16", "2026-11-21"),
  apk("netcat-openbsd", "1.239-r1", "2026-11-21"),
  apk("openssh-client", "10.6_p2-r0", "2026-11-21"),
  apk("openssl", "3.6.5-r6", "2026-11-21"),
  apk("patch", "2.8.1-r2", "2026-11-21"),
  apk("procps", "4.0.7-r4", "2026-11-21"),
  apk("rsync", "3.5.2-r1", "2026-11-21"),
  apk("sed", "4.10-r6", "2026-11-21"),
  apk("tzdata", "2026f-r1", "2026-11-21"),
  apk("unzip", "6.0-r9", "2026-11-21"),
  apk("wget", "1.25.0-r21", "2026-11-21"),
  apk("xz", "5.8.4-r2", "2026-11-21"),
  apk("zip", "3.0-r12", "2026-11-21"),
  apk("zstd", "1.5.7-r15", "2026-11-21"),
]);
