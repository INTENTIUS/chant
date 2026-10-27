/**
 * Paths of the provider network mirror under a registry (chant#4564), with no
 * Node imports, so the edge function can tell a mirror's version file apart.
 */

/** The mirror's place under the registry's prefix. */
export const PROVIDER_MIRROR_PREFIX = "providers";

/** True for a mirror's `providers/<host>/<ns>/<type>/<version>.json` path, with or without a prefix in front. */
export const isMirrorVersionPath = (path: string): boolean => new RegExp(`(^|/)${PROVIDER_MIRROR_PREFIX}/[^/]+/[^/]+/[^/]+/(?!index\\.json$)[^/]+\\.json$`).test(path.split("?")[0]!);
