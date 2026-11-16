/**
 * What chant builds is a job config Prow takes, by its schemas: the vendored
 * job config schema, which refuses a field Prow's types do not name, and the
 * vendored ProwJob CRD spec schema, against the spec Prow copies from each
 * job. loader.e2e.test.ts runs Prow's own strict config loader on the same
 * builds.
 */
import { describe, expect, test } from "vitest";
import Ajv from "ajv";
import { parseYAML } from "@intentius/chant/yaml";
import { jobConfigSchema, prowJobSpecSchema } from "./spec/schema";
import { jobsOf } from "./job-config";
import { builtConfigs, specOf } from "./testdata/built-configs";

const ajv = new Ajv({ strict: false, allErrors: true });
const prowJobSpec = ajv.compile(prowJobSpecSchema());
const jobConfig = ajv.compile(jobConfigSchema());

describe("the built job config against the vendored schemas", () => {
  test("each job config chant builds satisfies the job config schema, and each job's ProwJob spec the CRD's", async () => {
    for (const [what, text] of await builtConfigs()) {
      const doc = parseYAML(text);
      expect({ what, ok: jobConfig(doc), errors: jobConfig.errors }).toEqual({ what, ok: true, errors: null });
      for (const j of jobsOf(doc)) {
        const spec = specOf(j.type, j.job, j.repo);
        expect({ what, job: j.job.name, ok: prowJobSpec(spec), errors: prowJobSpec.errors }).toEqual({ what, job: j.job.name, ok: true, errors: null });
      }
    }
  }, 120_000);

  test("the schemas refuse a field Prow does not know, on a job and in its pod spec", () => {
    expect(jobConfig({ presubmits: { "acme/app": [{ name: "x", run_always: true }] } })).toBe(false);
    expect(jobConfig({ periodics: [{ name: "x", interval: "1h", spec: { containers: [{ name: "c", image: "i", bogus: 1 }] } }] })).toBe(false);
    expect(prowJobSpec({ type: "periodic", job: "x", pod_spec: { containers: [{ name: "c", image: "i", bogus: 1 }] } })).toBe(false);
  });
});

