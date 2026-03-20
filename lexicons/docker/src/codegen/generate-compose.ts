/**
 * Generate Compose entity types from the Compose Spec JSON Schema.
 */

import { fetchComposeSpec } from "../spec/fetch-compose";
import { parseComposeSpec, type ComposeParseResult } from "../spec/parse-compose";

export interface ComposeGenerateResult {
  results: ComposeParseResult[];
}

export async function generateComposePipeline(opts: { force?: boolean; verbose?: boolean } = {}): Promise<ComposeGenerateResult> {
  if (opts.verbose) console.error("Fetching Compose Spec...");
  const data = await fetchComposeSpec(opts.force);

  if (opts.verbose) console.error("Parsing Compose Spec...");
  const results = parseComposeSpec(data);

  if (opts.verbose) console.error(`Parsed ${results.length} Compose entity types`);
  return { results };
}
