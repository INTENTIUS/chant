import type { ChantConfig } from "@intentius/chant/config";
// Brings the `fountain` key into ChantConfig. Type-only, so reading this config
// pulls no lexicon package into the process.
import type {} from "@intentius/chant-lexicon-fountain";

// `fly` provides the deploy activities and the App/Machine resource types;
// `fountain` provides the steward the deploy op is scheduled on. The Op DSL and
// the base activities are core's own and need no entry.
//
// `fountain.profiles` is what `chant run fly-durable-deploy --on fountain`
// reads for an endpoint and a token. The token is always a variable name;
// FTN001 refuses a literal in that position.
export default {
  lexicons: ["fly", "fountain"],
  buildParams: {
    // The estate repo the steward's sandbox clones. Override it with
    // `chant build --param repoUrl=https://github.com/you/your-estate`.
    repoUrl: { type: "string", default: "https://github.com/INTENTIUS/chant" },
  },
  fountain: {
    profiles: {
      demo: {
        endpoint: "https://fountain.inevitable.fyi",
        token: { env: "FOUNTAIN_TOKEN" },
        team: "fly-steward",
      },
    },
    defaultProfile: "demo",
  },
} satisfies ChantConfig;
