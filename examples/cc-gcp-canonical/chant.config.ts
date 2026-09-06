import type { ChantConfig } from "@intentius/chant";

/**
 * The `local` environment declares floci-gcp's endpoint, so `--live` reads
 * reach the emulator without the caller exporting GCP_ENDPOINT_URL — an
 * ambient value still wins if one is set (see docs: Config File >
 * environments). The applier is told the endpoint explicitly by the deploy Op;
 * only the read path needs this injection.
 *
 * `gcp` is in the lexicon list so `chant run` loads the gcp applier activity;
 * the base activities come from core and need no lexicon at all.
 */
export default {
  lexicons: ["gcp"],
  sourceDir: "src",
  environments: [{ name: "local", endpoint: "http://localhost:4588" }],
} satisfies ChantConfig;
