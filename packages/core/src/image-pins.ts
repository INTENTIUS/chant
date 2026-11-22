/**
 * The container images the workflows chant generates run, and the Chainguard
 * bases of a product's CI image (`base: "chainguard"` in
 * `@intentius/chant/ci-image`, #5445), each pinned by the digest of its image
 * index (#4941), as {@link ../action-pins.ts} pins the actions by commit. A
 * tag can move; a digest cannot. A generator takes its image reference from
 * here, so an update is one change to this table. Each row names the tag it
 * followed when it was resolved, which the reference keeps beside the digest
 * so a reader sees the release. The Debian bases of a product's CI image stay
 * in `CI_BASE_IMAGES` in `ci-image.ts`.
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
