import { existsSync } from "fs";
import { dirname, join, resolve } from "path";

/**
 * Shared upward config-discovery walk (chant #1117).
 *
 * Before this, `chant build <subdir>` and `lint.policies`
 * (`./lint/policy.ts`'s `evaluateProjectPolicies`) each searched only the
 * build directory and its immediate parent for `chant.config.ts`/`.json`,
 * while `chant lint`/`chant graph` (`./lint/config.ts`'s old, file-local
 * `findProjectRoot`) already walked all the way up. A project with a deeper
 * `src/<stack>` layout — `chant build src/<stack>` two or more levels below
 * the project root — silently never found the root config: `buildParams`'
 * declared `env:` mappings went inert, `ownership`/`lint.policies`/etc quietly
 * fell back to defaults, and nothing warned (loomster#162: `LOOM_TIER`/
 * `LOOM_ENV` inert under every `npm run synth:*` for two releases).
 *
 * `findProjectConfig` is the one walk every config-discovery call site now
 * shares. It stops at the first of:
 *
 * 1. A directory holding `chant.config.ts` or `chant.config.json` — found.
 * 2. A directory holding `.git` or `package.json` with no chant config of its
 *    own — the project boundary. Discovery must never wander past the actual
 *    project into an unrelated ancestor directory just because this project
 *    happens not to declare a config (a stray `chant.config.ts` two levels
 *    above an unrelated git repo must never be picked up).
 * 3. `startDir` itself, unchanged, if the walk reaches the filesystem root
 *    without ever finding a config OR a boundary marker. This is not just a
 *    "give up gracefully" nicety — several callers (`resolveProjectLexicons`
 *    -> `findInfraFiles`) scope a real directory walk off this function's
 *    result; if a rootless/marker-less start dir (a bare tmpdir, as chant's
 *    own test suites use) resolved all the way to `/`, that downstream walk
 *    would scan the entire filesystem instead of failing fast. Falling back
 *    to `startDir` keeps every caller's blast radius local no matter how far
 *    up the walk had to look.
 */
export interface ProjectConfigSearch {
  /** The resolved project root: the config's directory, the boundary directory, or the (resolved) `startDir` when neither was found. */
  dir: string;
  /** Absolute path to the discovered `chant.config.ts`/`.json`, if any. */
  configPath?: string;
}

/** Walk up from `startDir` (inclusive) to the nearest chant config or project boundary. See {@link ProjectConfigSearch}. */
export function findProjectConfig(startDir: string): ProjectConfigSearch {
  const resolvedStart = resolve(startDir);
  let dir = resolvedStart;
  for (;;) {
    const tsPath = join(dir, "chant.config.ts");
    if (existsSync(tsPath)) return { dir, configPath: tsPath };
    const jsonPath = join(dir, "chant.config.json");
    if (existsSync(jsonPath)) return { dir, configPath: jsonPath };

    if (existsSync(join(dir, ".git")) || existsSync(join(dir, "package.json"))) {
      return { dir };
    }

    const parent = dirname(dir);
    if (parent === dir) {
      // Filesystem root, no config, no boundary ever seen — give up rather
      // than adopting "/" as the project root (see the module doc above).
      return { dir: resolvedStart };
    }
    dir = parent;
  }
}

/**
 * Walk up from `startDir` to the nearest ancestor holding a chant project
 * config (`chant.config.ts` or `chant.config.json`), the `.git`/`package.json`
 * project boundary, or `startDir` itself when neither is found. Thin wrapper
 * over {@link findProjectConfig} for callers that only need the directory
 * (e.g. `chant lint`'s rule/plugin resolution, which just needs *a* stable
 * root to resolve relative paths against).
 */
export function findProjectRoot(startDir: string): string {
  return findProjectConfig(startDir).dir;
}
