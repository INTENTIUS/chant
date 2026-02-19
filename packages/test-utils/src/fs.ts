import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Creates a unique temporary directory for testing
 * @param prefix - Optional prefix for the directory name (default: "chant-test")
 * @returns Path to the created temporary directory
 */
export async function createTestDir(prefix = "chant-test"): Promise<string> {
  const testDir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random()}`);
  await mkdir(testDir, { recursive: true });
  return testDir;
}

/**
 * Removes a temporary test directory
 * @param dir - Path to the directory to remove
 */
export async function cleanupTestDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Executes a function with an automatically managed test directory
 * Creates the directory before execution and cleans it up after, even if the function throws
 * @param fn - Async function to execute with the test directory path
 * @param prefix - Optional prefix for the directory name (default: "chant-test")
 * @returns The result of the function execution
 */
export async function withTestDir<T>(
  fn: (dir: string) => Promise<T>,
  prefix = "chant-test"
): Promise<T> {
  const testDir = await createTestDir(prefix);
  try {
    return await fn(testDir);
  } finally {
    await cleanupTestDir(testDir);
  }
}
