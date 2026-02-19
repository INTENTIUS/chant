import { statSync } from "fs";

/**
 * Cache entry for a single file
 */
interface FileCacheEntry {
  /** Last modified time in milliseconds */
  mtime: number;
  /** Entity names exported by this file */
  entityNames: string[];
}

/**
 * Discovery cache for incremental rebuilds.
 *
 * Tracks file mtimes and file→entity mappings so that only changed files
 * need to be re-imported during watch-mode rebuilds.
 */
export class DiscoveryCache {
  private files = new Map<string, FileCacheEntry>();

  /**
   * Check if a file has changed since it was last tracked.
   * Returns true if the file is new or its mtime has changed.
   */
  hasFileChanged(filePath: string): boolean {
    const entry = this.files.get(filePath);
    if (!entry) return true;

    try {
      const stat = statSync(filePath);
      return stat.mtimeMs !== entry.mtime;
    } catch {
      // File may have been deleted
      return true;
    }
  }

  /**
   * Record a successful import, storing the file's mtime and entity names.
   */
  trackFileImport(filePath: string, mtime: number, entityNames: string[]): void {
    this.files.set(filePath, { mtime, entityNames });
  }

  /**
   * Invalidate cache entries for the given files.
   * Returns the set of entity names that were invalidated.
   */
  invalidate(changedFiles: string[]): Set<string> {
    const invalidatedEntities = new Set<string>();

    for (const file of changedFiles) {
      const entry = this.files.get(file);
      if (entry) {
        for (const name of entry.entityNames) {
          invalidatedEntities.add(name);
        }
        this.files.delete(file);
      }
    }

    return invalidatedEntities;
  }

  /**
   * Get all tracked file paths.
   */
  trackedFiles(): string[] {
    return [...this.files.keys()];
  }

  /**
   * Get entity names for a tracked file.
   */
  getFileEntities(filePath: string): string[] | undefined {
    return this.files.get(filePath)?.entityNames;
  }

  /**
   * Clear all cached data.
   */
  clear(): void {
    this.files.clear();
  }
}
