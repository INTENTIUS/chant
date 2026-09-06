import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";

/**
 * The same one-root shape `examples/getting-started` uses. What differs is
 * next door in `ops/watch.op.ts`: an Op that plans this root on a cron and
 * opens an issue when the plan is not empty.
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
