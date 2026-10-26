import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-pulumi";

/**
 * Reads the `infra` member's graph into this project's build: the
 * `stack-export.json` checked in beside its `Pulumi.yaml`. `dir` is relative
 * to this file, the project root (PUL101 warns on an absolute one).
 *
 * `chant workspace graph` writes the same namespace into the reader project
 * it makes for the member, so the workspace needs no chant.config.ts at all.
 * This one is here so `chant build` and `chant lint` show what the lexicon
 * reads and what PUL001 and PUL002 report.
 */
export default {
  lexicons: ["pulumi"],
  pulumi: {
    member: { dir: "./infra", label: "infra" },
  },
} satisfies ChantConfig;
