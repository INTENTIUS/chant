import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-cedar";

// The dogwood helpers (`defaultEventSchema()`, `formerly(...)`, `ctx(...)`,
// `agentCoreStagedPolicy(...)`) are plain function calls, and the policy set
// spreads their results into the deployment props. Build runs the file rather
// than folding it, so those calls are valid here. EVL001 and EVL004 describe
// the fold subset and would flag every one of them.
export default {
  lexicons: ["cedar"],
  lint: { rules: { EVL001: "off", EVL004: "off" } },
} satisfies ChantConfig;
