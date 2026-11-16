import { Presubmit } from "@intentius/chant-lexicon-prow";

// The token is written into the job config.
export const e2e = new Presubmit({
  repo: "acme/app",
  name: "pull-app-e2e",
  spec: {
    containers: [{ name: "test", image: "golang:1.26", env: [{ name: "GITHUB_TOKEN", value: "ghp_example" }] }],
  },
});
