/**
 * Slurm schema fetcher — serves the inline Slurm 23.11 REST API spec.
 *
 * Unlike cloud providers (AWS/GCP), Slurm's OpenAPI spec is generated
 * dynamically by slurmrestd at runtime and is not distributed as a static
 * artifact. We bundle the relevant subset in slurm-rest-spec.ts and return
 * it as a typed Map<typeName, Buffer> that the generatePipeline expects.
 */

import { SLURM_REST_RESOURCES } from "./slurm-rest-spec";

/**
 * Return Slurm REST resource schemas.
 *
 * Each entry in the map is: typeName → JSON Buffer of the resource definition.
 * The pipeline calls parseSchema(typeName, buf) for each entry.
 */
export async function fetchSchemas(_opts?: { force?: boolean }): Promise<Map<string, Buffer>> {
  const schemas = new Map<string, Buffer>();

  for (const resource of SLURM_REST_RESOURCES) {
    const buf = Buffer.from(JSON.stringify(resource));
    schemas.set(resource.typeName, buf);
  }

  return schemas;
}
