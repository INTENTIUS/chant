/**
 * chant configuration for the fountain steward example.
 *
 * `fountain.profiles` is what `chant run <op> --on fountain` reads for an
 * endpoint and a token. The token is always a variable name; FTN001 refuses a
 * literal in that position, whatever it looks like.
 */

import type { ChantConfig } from "@intentius/chant/config";
// Brings the `fountain` key into ChantConfig. Type-only, so nothing about
// reading this config pulls a lexicon package into the process (or into the
// bundle `chant build --sandbox` makes of it).
import type {} from "@intentius/chant-lexicon-fountain";

export default {
  lexicons: ["fountain"],
  buildParams: {
    // The estate repo the steward's sandbox clones. Override it with
    // `chant build --param repoUrl=https://github.com/you/your-estate`.
    repoUrl: { type: "string", default: "https://github.com/INTENTIUS/chant" },
  },
  fountain: {
    profiles: {
      prod: {
        endpoint: "https://fountain.inevitable.fyi",
        token: { env: "FOUNTAIN_TOKEN" },
        // The teammate a run posts to when the op is not listed on a Steward
        // this process loaded. The Steward below lists both, so this is the
        // fallback rather than the usual path.
        team: "prod-steward",
      },
    },
    defaultProfile: "prod",
  },
} satisfies ChantConfig;
