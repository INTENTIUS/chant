import { expect } from "vitest";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { e2bSerializer } from "@intentius/chant-lexicon-e2b";

describeAllExamples(
  {
    lexicon: "e2b",
    serializer: e2bSerializer,
    outputKey: "e2b",
    examplesDir: import.meta.dirname,
  },
  {
    steward: {
      checks: (output) => {
        const index = JSON.parse(output) as { templates: Record<string, { name: string; dockerfile: string; config: string }> };
        expect(index.templates.steward).toMatchObject({
          name: "chant-steward",
          dockerfile: "e2b.chant-steward.Dockerfile",
          config: "e2b.chant-steward.toml",
        });
      },
    },
  },
);
