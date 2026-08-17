import type { ChantConfig } from "@intentius/chant";

/**
 * Three values vary per deployment: the GCP project the estate lives in, that
 * project's number (Google-managed service-agent emails are keyed by number,
 * not ID), and the base domain the three regional UIs hang off.
 *
 * They are declared here as build-time parameters rather than read from
 * `process.env` in source. The env mapping keeps `set -a && source .env` working
 * exactly as before, but the read is now explicit, validated, and — the reason
 * that matters here — foldable: an ambient `process.env` read at module scope
 * forced nine of this example's twelve regional files onto the run path, and
 * every regional stack had to switch EVL001 off to permit it.
 *
 * The defaults are placeholders that build but do not deploy. Supply real ones
 * with `--param`, `--params-file`, or the env vars in `.env`.
 */
export default {
  lexicons: ["gcp", "k8s"],

  // Stamped onto every emitted resource as `chant.intentius.io/stack`, next to
  // `app.kubernetes.io/managed-by=chant`. This is what lets a later prune tell
  // this estate's resources from anything else in the project — ownership is a
  // marker on the live resource, never a state file chant hosts.
  ownership: { stack: "crdb-multi-region" },

  environments: ["prod"],

  /**
   * Each stack under `src/` carries a `chant.config.json` holding only
   * `extends` + `rules` — a lint-scoping fragment, which the project-config
   * walk skips on its way here. Those fragments used to also carry a
   * `_ruleNotes` object explaining each disable; an unrecognized key stops the
   * walk dead, so this file (and with it every parameter, the lexicon list and
   * the ownership marker) was never reached. The notes live here instead:
   *
   *   COR001  inline objects — composite props read better inline
   *   COR004  unused exports — resources are consumed by serializers
   *   COR009  file-count limit — too strict for a 4-stack, 3-region estate
   *   COR013  mixed resource/config — region config sits next to its resources
   *   EVL001  one remaining non-literal: the `ALL_CIDRS.map(...)` that shapes
   *           the allow-cockroachdb NetworkPolicy's `from` list. It used to
   *           cover the `process.env` reads too; those are build parameters
   *           now, and the map goes away when the region stacks move onto the
   *           k8s lexicon's CockroachDbRegionStack, which takes the CIDRs as
   *           data and does the shaping itself.
   *   EVL004  spread from shared config (CRDB_CLUSTER) is static and traceable
   *   WGC002  hardcoded regions — the 3 regions ARE the topology
   *   WK8001  hardcoded namespaces — one dedicated namespace per region
   */

  buildParams: {
    projectId: {
      type: "string",
      default: "my-project",
      env: "GCP_PROJECT_ID",
      description: "GCP project the whole estate is created in",
    },
    projectNumber: {
      type: "string",
      default: "000000000000",
      env: "GCP_PROJECT_NUMBER",
      description:
        "GCP project number — Google-managed service agents (the GCS agent that uses the CMEK key) are addressed by number. gcloud projects describe $GCP_PROJECT_ID --format='value(projectNumber)'",
    },
    domain: {
      type: "string",
      default: "crdb.example.com",
      env: "CRDB_DOMAIN",
      description: "Base domain for the UI ingresses — east.<domain>, central.<domain>, west.<domain>",
    },
  },
} satisfies ChantConfig;
