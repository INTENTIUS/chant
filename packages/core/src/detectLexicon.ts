import { readFile } from "node:fs/promises";

/**
 * Detects which lexicons are being used by analyzing import statements
 * in the provided infrastructure files. Matches any `@intentius/chant-lexicon-*` package.
 *
 * @param files - Array of file paths to analyze
 * @returns Array of detected lexicon names
 * @throws Error if no lexicon is detected
 */
export async function detectLexicons(files: string[]): Promise<string[]> {
  const detectedLexicons = new Set<string>();

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch (error) {
      // Skip files that can't be read
      continue;
    }

    // Match @intentius/chant-lexicon-<name> in import/export statements
    const regex = /(?:import|export)\s+.*\s+from\s+['"]@intentius\/chant-lexicon-([a-z][\w-]*)['"]/g;

    for (const match of content.matchAll(regex)) {
      detectedLexicons.add(match[1]);
    }
  }

  // Validate results
  if (detectedLexicons.size === 0) {
    throw new Error("No lexicon detected in infrastructure files");
  }

  return Array.from(detectedLexicons);
}
