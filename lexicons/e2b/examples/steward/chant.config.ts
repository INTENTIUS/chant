import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-e2b";

// One profile for hosted E2B. `template` names the Template in src/steward.ts,
// so a steward made from this profile starts with jq and the GitHub CLI in it.
// Secrets are named by environment variable, never written here.
export default {
  lexicons: ["e2b"],
  e2b: {
    profiles: {
      prod: {
        apiKey: { env: "E2B_API_KEY" },
        template: "chant-steward",
        steward: "prod-steward",
        gitToken: { env: "GITHUB_TOKEN" },
      },
    },
    defaultProfile: "prod",
  },
} satisfies ChantConfig;
