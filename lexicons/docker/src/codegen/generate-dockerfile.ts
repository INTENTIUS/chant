/**
 * Generate Dockerfile entity types from the Docker Engine API OpenAPI spec.
 */

import { fetchEngineApi } from "../spec/fetch-engine";
import { parseEngineApi, type DockerfileParseResult } from "../spec/parse-engine";

export interface DockerfileGenerateResult {
  result: DockerfileParseResult;
}

export async function generateDockerfilePipeline(opts: { force?: boolean; verbose?: boolean } = {}): Promise<DockerfileGenerateResult> {
  if (opts.verbose) console.error("Fetching Docker Engine API...");
  const data = await fetchEngineApi(opts.force);

  if (opts.verbose) console.error("Parsing Engine API for Dockerfile types...");
  const result = parseEngineApi(data);

  if (opts.verbose) console.error(`Parsed ${result.instructions.length} Dockerfile instructions`);
  return { result };
}
