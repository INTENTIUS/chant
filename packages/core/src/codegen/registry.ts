/**
 * Locating a lexicon's generated registry (#1367).
 *
 * The registry — every resource type the lexicon knows, keyed by class name —
 * is written to two places by `npm run --prefix lexicons/<name> prepack`:
 * `src/generated/lexicon-<name>.json` by the generate step, and `dist/meta.json`
 * by the bundle step, byte-identical. Both are gitignored, so a fresh clone has
 * neither until that command runs; CI runs it explicitly before anything else.
 *
 * That is a legitimate state. Being silent about it is not, and the two readers
 * that needed the registry were silent in opposite directions:
 *
 * - AWS's import generator `require`d `dist/meta.json` with no catch, so a
 *   fresh clone got `Cannot find module …/lexicons/aws/dist/meta.json` — from
 *   `chant import`, and from twelve tests that mention neither modules nor
 *   registries.
 * - Azure's caught the failure and continued with an empty map, so the import
 *   emitted `// Unknown resource type: Microsoft.Network/virtualNetworks` and
 *   its round-trip tests failed as though the registry were incomplete. That is
 *   the worse of the two: it looks like a coverage gap in the lexicon.
 *
 * Both now go through here, which tries the dev path first (matching what the
 * azure serializer already did) and, failing both, says what to run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Thrown when neither copy of the registry exists — carries the fix. */
export class LexiconRegistryMissingError extends Error {
  constructor(readonly lexicon: string) {
    super(
      `${lexicon} lexicon registry not found — it is a build artifact and this checkout has not built it.\n` +
        `Run: npm run --prefix lexicons/${lexicon} prepack\n` +
        `(generate writes src/generated/lexicon-${lexicon}.json; bundle writes dist/meta.json)`,
    );
    this.name = "LexiconRegistryMissingError";
  }
}

/** One entry in a lexicon's generated registry. */
export interface LexiconRegistryEntry {
  resourceType: string;
  kind: string;
  apiVersion?: string;
}

/**
 * Read a lexicon's generated registry, dev copy first.
 *
 * `pkgDir` is the lexicon PACKAGE directory (the one holding `src/` and
 * `dist/`) — callers pass an `import.meta.dirname`-derived path, so this stays
 * free of assumptions about where it is imported from. Throws
 * {@link LexiconRegistryMissingError} when neither copy exists, rather than
 * returning an empty map that reads downstream as a lexicon with no resource
 * types at all.
 */
export function loadLexiconRegistry(pkgDir: string, lexicon: string): Record<string, LexiconRegistryEntry> {
  for (const candidate of [
    join(pkgDir, "src", "generated", `lexicon-${lexicon}.json`),
    join(pkgDir, "dist", "meta.json"),
  ]) {
    try {
      return JSON.parse(readFileSync(candidate, "utf-8")) as Record<string, LexiconRegistryEntry>;
    } catch {
      // Try the next candidate; only both failing is an error.
    }
  }
  throw new LexiconRegistryMissingError(lexicon);
}
