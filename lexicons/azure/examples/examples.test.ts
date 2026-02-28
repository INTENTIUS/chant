import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { azureSerializer } from "@intentius/chant-lexicon-azure";

describeAllExamples({
  lexicon: "azure",
  serializer: azureSerializer,
  outputKey: "azure",
  examplesDir: import.meta.dir,
});
