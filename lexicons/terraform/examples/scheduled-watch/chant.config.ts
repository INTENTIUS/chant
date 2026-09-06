import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";

/**
 * The same one-root shape `examples/getting-started` uses. What differs is
 * `src/watch.op.ts`: an Op that plans this root on a cron and opens an issue
 * when the plan is not empty. It lives in `src/` since chant #2101, so
 * `chant dev check-lexicon`'s example build discovers it and runs core's own
 * OPS012/OPS013 over its steps.
 */
export default {
  lexicons: ["terraform"],
  terraform: {
    binary: "terraform",
    roots: {
      app: { dir: "./terraform" },
    },
  },
} satisfies ChantConfig;
