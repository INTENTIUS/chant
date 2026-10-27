import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-pulumi";

/**
 * The `workspace-member` example's member read, plus `src/watch.op.ts`, a
 * `PulumiWatchOp` over the same `infra/` program. Listing `pulumi` here is
 * what loads the `pulumiPreview` and `pulumiDrift` activities the Op calls.
 * The Op lives in `src/`, so `chant dev check-lexicon`'s example build
 * discovers it and runs core's OPS checks over its steps.
 */
export default {
  lexicons: ["pulumi"],
  pulumi: {
    member: { dir: "./infra", label: "infra" },
  },
} satisfies ChantConfig;
