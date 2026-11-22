/**
 * The command-line tools the workflows chant generates download, each pinned
 * by the SHA-256 of its release file for every platform a job runs on, as
 * {@link ./image-pins.ts} pins images by digest and ../action-pins.ts pins
 * actions by commit. A generated step downloads the file, checks it against
 * the digest and refuses to run anything else, so a moved release asset
 * fails the job instead of running. Each row names the release it was read
 * from, so an update is one change here.
 *
 * Refresh a row from the release's checksums file:
 *
 *   curl -sL https://github.com/sigstore/cosign/releases/download/v3.1.4/cosign_checksums.txt | grep -E 'cosign-linux-(amd64|arm64)$'
 *   gh release download v2.19.0 -R goreleaser/goreleaser -p checksums.txt -O - | grep -E 'goreleaser_Linux_(x86_64|arm64)\.tar\.gz$'
 *   gh release download v2.48.0 -R goreleaser/nfpm -p checksums.txt -O - | grep -E 'nfpm_2.48.0_Linux_(x86_64|arm64)\.tar\.gz$'
 *   gh release download v0.121.1 -R anchore/grype -p grype_0.121.1_checksums.txt -O - | grep -E 'linux_(amd64|arm64)\.tar\.gz$'
 *   gh release download v1.56.0 -R anchore/syft -p syft_1.56.0_checksums.txt -O - | grep -E 'linux_(amd64|arm64)\.tar\.gz$'
 */

export interface ToolPin {
  /** The tool's name: the binary the step leaves in its directory. */
  readonly name: string;
  /** The release the row was read from, such as `v3.1.4`. */
  readonly version: string;
  /** Set when each platform's file is a `.tar.gz` that holds the binary, rather than the binary itself. */
  readonly archive?: boolean;
  /** Each platform's download URL and the SHA-256 of the file, as hex. */
  readonly platforms: Readonly<Record<string, { readonly url: string; readonly sha256: string }>>;
}

const cosign = (version: string, sums: Record<string, string>): ToolPin => ({
  name: "cosign",
  version,
  platforms: Object.fromEntries(Object.entries(sums).map(([platform, sha256]) => [platform, { url: `https://github.com/sigstore/cosign/releases/download/${version}/cosign-${platform.replace("/", "-")}`, sha256 }])),
});

const goreleaser = (version: string, sums: Record<string, [string, string]>): ToolPin => ({
  name: "goreleaser",
  version,
  archive: true,
  platforms: Object.fromEntries(Object.entries(sums).map(([platform, [asset, sha256]]) => [platform, { url: `https://github.com/goreleaser/goreleaser/releases/download/${version}/${asset}`, sha256 }])),
});

const nfpm = (version: string, sums: Record<string, [string, string]>): ToolPin => ({
  name: "nfpm",
  version,
  archive: true,
  platforms: Object.fromEntries(Object.entries(sums).map(([platform, [asset, sha256]]) => [platform, { url: `https://github.com/goreleaser/nfpm/releases/download/${version}/${asset}`, sha256 }])),
});

/** An Anchore tool (grype, syft): a `.tar.gz` per platform named `<tool>_<version>_<os>_<arch>.tar.gz`. */
const anchore = (tool: "grype" | "syft", version: string, sums: Record<string, string>): ToolPin => ({
  name: tool,
  version,
  archive: true,
  platforms: Object.fromEntries(
    Object.entries(sums).map(([platform, sha256]) => [platform, { url: `https://github.com/anchore/${tool}/releases/download/${version}/${tool}_${version.replace(/^v/, "")}_${platform.replace("/", "_")}.tar.gz`, sha256 }]),
  ),
});

export const TOOL_PINS = {
  // #5164: Sigstore signing at publish. v3.1.4 was released 2026-10-20; the sums are its cosign_checksums.txt's.
  cosign: cosign("v3.1.4", {
    "linux/amd64": "424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa",
    "linux/arm64": "ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2",
  }),
  // #5151: release.artifacts entries goreleaser builds. v2.19.0 was released 2026-10-22; the sums are its checksums.txt's.
  goreleaser: goreleaser("v2.19.0", {
    "linux/amd64": ["goreleaser_Linux_x86_64.tar.gz", "ebc3194ad1d1b1787614405285a0039665cd4c5bd3305215a1b201600f90630b"],
    "linux/arm64": ["goreleaser_Linux_arm64.tar.gz", "ef33741b684c9f62d6a21e7a3c8b051f139ea7b1d301693b67cc819c46226d53"],
  }),
  // #5233: release.artifacts entries nfpm packages. v2.48.0 was released 2026-10-12; the sums are its checksums.txt's.
  nfpm: nfpm("v2.48.0", {
    "linux/amd64": ["nfpm_2.48.0_Linux_x86_64.tar.gz", "6d7f9a28b2f397934403950fcbba83f598b08d02edbe79a0815b3b4897341750"],
    "linux/arm64": ["nfpm_2.48.0_Linux_arm64.tar.gz", "a9a75213763783b7669719e505474c748c5ad7dc66591a195619deb50f85c2f4"],
  }),
  // #5446: the scan before the stage. v0.121.1 was released 2026-11-02; the sums are its grype_0.121.1_checksums.txt's.
  grype: anchore("grype", "v0.121.1", {
    "linux/amd64": "bc3ea3f9e6fd56ac781c08c6c5e614271b79f438200757f6932085c19b0a4657",
    "linux/arm64": "33670612aad351c48cf3c37f4a85d8b043d1b64b21e6034e675bb00b956d78c1",
  }),
  // #5446: the image SBOM the scan reads. v1.56.0 was released 2026-11-02; the sums are its syft_1.56.0_checksums.txt's.
  syft: anchore("syft", "v1.56.0", {
    "linux/amd64": "1c2493cfcf52d3367d6cb25780d9190c111c2219c34c820574c43e8bae15c528",
    "linux/arm64": "ace61b9397ae28189c674ae332d67a8074dafd71e87724dfb8b22412d8253bb5",
  }),
} as const satisfies Record<string, ToolPin>;

/**
 * Shell that downloads `pin` for `platform` into `dir`, checks its SHA-256
 * and leaves the executable `<dir>/<name>`: made executable, or unpacked
 * from the archive. It fails, and so fails the step, when the file is not
 * the pinned one. Throws for a platform the row has no file for.
 */
export function toolInstallLine(pin: ToolPin, platform: string, dir: string): string {
  const file = pin.platforms[platform];
  if (!file) throw new Error(`${pin.name} ${pin.version} is pinned for ${Object.keys(pin.platforms).join(", ")}, not ${platform}`);
  if (pin.archive) {
    const tgz = `${dir}/${pin.name}.tar.gz`;
    return `mkdir -p "${dir}" && curl -fsSL -o "${tgz}" ${file.url} && echo "${file.sha256}  ${tgz}" | sha256sum -c - && tar -xzf "${tgz}" -C "${dir}" ${pin.name}`;
  }
  const path = `${dir}/${pin.name}`;
  return `curl -fsSL -o "${path}" ${file.url} && echo "${file.sha256}  ${path}" | sha256sum -c - && chmod +x "${path}"`;
}
