/**
 * The vendored Prow schemas (./vendor.ts writes them), read from beside this
 * module: src/spec/ in a checkout, dist/spec/ in the published package.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleSourceDir } from "@intentius/chant/module-source";

const DIR = moduleSourceDir(import.meta.url);

/** The job config schema: the job kinds Prow loads and every type they nest. */
export function jobConfigSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DIR, "job-config.schema.json"), "utf-8")) as Record<string, unknown>;
}

/** The `spec` of Prow's ProwJob CRD, which every ProwJob Prow makes from a job satisfies. */
export function prowJobSpecSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DIR, "prowjob-spec.schema.json"), "utf-8")) as Record<string, unknown>;
}

/** The schema keyed for core's generatePipeline: one document, which the parse step splits into entities. */
export function readSchemas(): Map<string, Buffer> {
  return new Map([["Prow::JobConfig", readFileSync(join(DIR, "job-config.schema.json"))]]);
}
