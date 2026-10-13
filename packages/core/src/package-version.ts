/**
 * `@intentius/chant`'s own version, read from its package.json as a file. The
 * path is the same from `src/` and `dist/`. The slim wave-job runtime (#3896)
 * has no package.json beside it, and its build writes the version in here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function readChantPackageVersion(): string {
  return (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf-8")) as { version: string }).version;
}
