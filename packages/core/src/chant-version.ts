import { createRequire } from "node:module";

/**
 * The installed chant's version, read from `@intentius/chant`'s own
 * package.json, or "0.0.0" when it can't be read. The path is the same from
 * `src/` and `dist/`, so it holds whether chant runs from source or from its
 * build. Kept outside `cli/` so that a module the Op entry loads, such as the
 * run-event writer (#4041), can name the version without loading the CLI.
 */
export const CHANT_VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
