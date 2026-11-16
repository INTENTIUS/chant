import { expect } from "vitest";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { prowSerializer } from "@intentius/chant-lexicon-prow";

describeAllExamples(
  {
    lexicon: "prow",
    serializer: prowSerializer,
    outputKey: "prow",
    examplesDir: import.meta.dirname,
  },
  {
    "ci-jobs": {
      checks: (output) => {
        expect(output.startsWith("# Written by chant build from src/jobs.ts.")).toBe(true);
        expect(output).toContain("presubmits:\n  acme/app:\n    - name: pull-app-unit\n");
        expect(output.indexOf("pull-app-unit")).toBeLessThan(output.indexOf("pull-app-docs"));
        expect(output).toContain("periodics:\n  - name: periodic-app-e2e\n    cluster: trusted\n    cron: '0 3 * * *'\n");
        expect(output).not.toContain("repo: acme/app\n    - ");
      },
    },
  },
);
