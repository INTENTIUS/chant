/**
 * Known deprecated or EOL Docker base images.
 */

export const DEPRECATED_IMAGES: Array<{ image: string; reason: string; replacement?: string }> = [
  {
    image: "centos:8",
    reason: "CentOS 8 reached EOL on December 31, 2021",
    replacement: "rockylinux:8 or almalinux:8",
  },
  {
    image: "centos:latest",
    reason: "CentOS Stream is a rolling release; use a specific version",
    replacement: "rockylinux:9 or almalinux:9",
  },
  {
    image: "node:lts",
    reason: "Use a specific LTS version tag for reproducible builds",
    replacement: "node:20-alpine or node:22-alpine",
  },
];

/**
 * Check if an image reference matches a deprecated entry.
 */
export function findDeprecatedImage(imageRef: string): (typeof DEPRECATED_IMAGES)[number] | undefined {
  return DEPRECATED_IMAGES.find((d) => imageRef === d.image || imageRef.startsWith(d.image + "@"));
}
