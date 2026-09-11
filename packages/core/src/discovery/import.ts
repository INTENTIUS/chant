import { DiscoveryError } from "../errors";

/**
 * Modules whose evaluation threw, and the error each threw with (#2368).
 *
 * The ES module spec says an evaluation failure is recorded on the module
 * record and re-thrown on every later import of the same specifier, forever,
 * in that realm. Node implements it — including after the file is edited, so a
 * module that threw keeps throwing until the process restarts.
 *
 * Vitest's module runner does not. It caches the module as *evaluated* and
 * hands later importers a namespace carrying whichever bindings were
 * initialized before the throw, so the second import resolves with
 * half-initialized exports and no error at all.
 *
 * That divergence is invisible to `chant build`, which imports a directory
 * once per process, and highly visible to anything that builds the same
 * directory twice and compares: whichever build ran first carried the error
 * and every build after it reported none, so error parity came out of the
 * ordering rather than out of the tool.
 *
 * This map is what makes the answer the same either way. Under Node it never
 * fires — `import()` throws again before the lookup matters — so it costs
 * nothing and changes nothing there. Under a runner that forgets, it supplies
 * the memory the spec requires.
 */
const evaluationFailures = new Map<string, DiscoveryError>();

/**
 * Forget every recorded evaluation failure.
 *
 * For a harness that deliberately starts a fresh module graph and wants the
 * failures forgotten with it. Nothing in chant calls this: a real build
 * imports once, and a second import inside one process is supposed to see what
 * the first one saw.
 *
 * It does not make a module re-evaluate. Node's own registry still holds the
 * failed record and still re-throws; this only clears chant's memory of it. A
 * caller wanting genuine re-evaluation needs a fresh process.
 */
export function resetImportFailures(): void {
  evaluationFailures.clear();
}

/**
 * Dynamically import a module and return its exports.
 *
 * @param path - The file path to import
 * @returns The module exports
 * @throws {DiscoveryError} with type "import" if the import fails, including
 *   on every later import of a module whose evaluation has already failed
 */
export async function importModule(
  path: string
): Promise<Record<string, unknown>> {
  const failed = evaluationFailures.get(path);
  if (failed) throw failed;

  try {
    return await import(path);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown import error";
    const discoveryError = new DiscoveryError(path, message, "import");
    evaluationFailures.set(path, discoveryError);
    throw discoveryError;
  }
}
