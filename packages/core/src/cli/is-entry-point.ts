import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the module identified by `importMetaUrl` is the process entry point
 * (`process.argv[1]`) — i.e. run directly, not imported.
 *
 * A naive `import.meta.url === \`file://${process.argv[1]}\`` is a false negative
 * whenever the invocation path crosses a symlink (pnpm, global bins, a symlinked
 * checkout, the npm `.bin` shim, `/tmp`→`/private/tmp`): the loader canonicalises
 * `import.meta.url` to the realpath while `argv[1]` keeps the symlink, so the CLI
 * silently exits 0 having done nothing. Canonicalise both sides so the entry
 * point is detected regardless of how the path was spelled.
 */
export function isEntryPoint(argv1: string | undefined, importMetaUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
