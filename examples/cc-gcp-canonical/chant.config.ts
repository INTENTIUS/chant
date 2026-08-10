import type { ChantConfig } from "@intentius/chant";

/**
 * The `local` environment declares floci-gcp's endpoint, so `--live` reads
 * reach the emulator without the caller exporting GCP_ENDPOINT_URL — an
 * ambient value still wins if one is set (see docs: Config File >
 * environments). The applier is told the endpoint explicitly by the deploy Op;
 * only the read path needs this injection.
 *
 * `temporal` is in the lexicon list so `chant run` loads the gcp applier
 * activity alongside the base ones (same wiring as local-cloud-trio).
 */
export default {
  lexicons: ["gcp", "temporal"],
  sourceDir: "src",
  environments: [{ name: "local", endpoint: "http://localhost:4588" }],
} satisfies ChantConfig;
