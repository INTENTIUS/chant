/**
 * The goreleaser a generated release workflow installs (#5151), pinned by
 * the SHA-256 of its release archive for each platform a job runs on, as
 * ./image-pins.ts pins images by digest and ./action-pins.ts pins actions by
 * commit. The generated step downloads the archive, checks it against the
 * digest, unpacks the binary and points `CHANT_GORELEASER` at it, so a moved
 * release asset fails the job instead of running. The row names the release
 * it was read from, so an update is one change here.
 *
 * Refresh the row from the release's checksums file:
 *
 *   gh release download v2.19.0 -R goreleaser/goreleaser -p checksums.txt -O - | grep -E 'goreleaser_Linux_(x86_64|arm64)\.tar\.gz$'
 */

export interface GoreleaserPin {
  /** The release the row was read from, such as `v2.19.0`. */
  readonly version: string;
  /** Each platform's archive URL and the SHA-256 of the archive, as hex. */
  readonly platforms: Readonly<Record<string, { readonly url: string; readonly sha256: string }>>;
}

const archive = (version: string, sums: Record<string, [string, string]>): GoreleaserPin => ({
  version,
  platforms: Object.fromEntries(
    Object.entries(sums).map(([platform, [asset, sha256]]) => [platform, { url: `https://github.com/goreleaser/goreleaser/releases/download/${version}/${asset}`, sha256 }]),
  ),
});

/** v2.19.0 was released 2026-10-22; the sums are its checksums.txt's. */
export const GORELEASER_PIN: GoreleaserPin = archive("v2.19.0", {
  "linux/amd64": ["goreleaser_Linux_x86_64.tar.gz", "ebc3194ad1d1b1787614405285a0039665cd4c5bd3305215a1b201600f90630b"],
  "linux/arm64": ["goreleaser_Linux_arm64.tar.gz", "ef33741b684c9f62d6a21e7a3c8b051f139ea7b1d301693b67cc819c46226d53"],
});

/**
 * Shell that downloads the pinned goreleaser for `platform` into `dir`,
 * checks the archive's SHA-256, and unpacks the `goreleaser` binary there.
 * It fails, and so fails the step, when the archive is not the pinned one.
 * Throws for a platform the row has no archive for.
 */
export function goreleaserInstallLine(platform: string, dir: string): string {
  const file = GORELEASER_PIN.platforms[platform];
  if (!file) throw new Error(`goreleaser ${GORELEASER_PIN.version} is pinned for ${Object.keys(GORELEASER_PIN.platforms).join(", ")}, not ${platform}`);
  const tgz = `${dir}/goreleaser.tar.gz`;
  return `mkdir -p "${dir}" && curl -fsSL -o "${tgz}" ${file.url} && echo "${file.sha256}  ${tgz}" | sha256sum -c - && tar -xzf "${tgz}" -C "${dir}" goreleaser`;
}
