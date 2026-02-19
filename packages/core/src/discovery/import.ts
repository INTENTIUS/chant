import { DiscoveryError } from "../errors";

/**
 * Dynamically import a module and return its exports.
 *
 * @param path - The file path to import
 * @returns The module exports
 * @throws {DiscoveryError} with type "import" if the import fails
 */
export async function importModule(
  path: string
): Promise<Record<string, unknown>> {
  try {
    return require(path);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown import error";
    throw new DiscoveryError(path, message, "import");
  }
}
