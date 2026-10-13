import type { ChantConfig } from "@intentius/chant";

// One lexicon, one environment. `chant lifecycle diff local --live` reads the
// cluster your current kube context points at.
export default {
  lexicons: ["k8s"],
} satisfies ChantConfig;
