/**
 * The container images the workflows chant generates run, each pinned by the
 * digest of its image index (#4941), as {@link ../action-pins.ts} pins the
 * actions by commit. A tag can move; a digest cannot. A generator takes its
 * image reference from here, so an update is one change to this table. Each
 * row names the tag it followed when it was resolved, which the reference
 * keeps beside the digest so a reader sees the release.
 *
 * Refresh a row by resolving its tag to the index digest:
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
} as const satisfies Record<string, ImagePin>;

/** The reference a pin is run by: `<repository>:<tag>@<digest>`. Docker pulls by the digest and ignores the tag. */
export const imageRef = (p: ImagePin): string => `${p.repository}:${p.tag}@${p.digest}`;
