import { expect } from "vitest";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { flySerializer } from "@intentius/chant-lexicon-fly";

describeAllExamples(
  {
    lexicon: "fly",
    serializer: flySerializer,
    outputKey: "fly",
    examplesDir: import.meta.dirname,
  },
  {
    "getting-started": {
      checks: (output) => {
        expect(output).toContain('"app_name": "my-app"');
        expect(output).toContain('"endpoint": "/v1/apps"');
        expect(output).toContain('"image": "flyio/hellofly:latest"');
      },
    },
  },
);
