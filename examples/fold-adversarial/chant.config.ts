import type { ChantConfig } from "@intentius/chant";

/**
 * Not optional, and not decoration. Without a `chant.config.*` here,
 * `findProjectConfig` (`packages/core/src/project-root.ts`) walks up from
 * `src/`, finds no config and no `package.json` in this directory or in
 * `examples/`, and stops at the repo root's `.git` — which is the documented
 * behaviour, and which makes `chant lint src` lint the entire repository. On
 * this machine that is 369,692ms against 51ms with this file present. Every
 * other example carries one; this one is a differential fixture rather than a
 * project, and it still needs the boundary.
 */
export default { lexicons: ["k8s"] } satisfies ChantConfig;
