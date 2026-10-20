import { createRequire } from "module";
import { moduleSourceUrl } from "@intentius/chant/module-source";
import { LexiconIndex, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";

const require = createRequire(moduleSourceUrl(import.meta.url));

let cached: LexiconIndex | null = null;

/** The generated entity registry, indexed once. Empty when generation has not run. */
export function registryIndex(): LexiconIndex {
  if (cached) return cached;
  let data: Record<string, LexiconEntry> = {};
  try {
    data = require("../generated/lexicon-sql.json") as Record<string, LexiconEntry>;
  } catch {
    // No src/generated/ yet (a fresh clone before `npm run generate`): nothing to complete.
  }
  cached = new LexiconIndex(data);
  return cached;
}
