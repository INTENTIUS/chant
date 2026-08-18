import { expect } from "vitest";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { renderSerializer } from "@intentius/chant-lexicon-render";

describeAllExamples(
  {
    lexicon: "render",
    serializer: renderSerializer,
    outputKey: "render",
    examplesDir: import.meta.dirname,
  },
  {
    "getting-started": {
      checks: (output) => {
        expect(output).toContain('"endpoint": "/services"');
        expect(output).toContain('"endpoint": "/postgres"');
        expect(output).toContain('"type": "web_service"');
        expect(output).toContain('"attribute": "internalConnectionString"');
        expect(output).toContain('"key": "CHANT_MANAGED_BY"');
      },
    },
  },
);
