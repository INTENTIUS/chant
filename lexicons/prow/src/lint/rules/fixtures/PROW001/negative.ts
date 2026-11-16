import { Presubmit } from "@intentius/chant-lexicon-prow";

// The token comes from a Secret, and the literal is not a credential.
export const e2e = new Presubmit({
  repo: "acme/app",
  name: "pull-app-e2e",
  spec: {
    containers: [
      {
        name: "test",
        image: "golang:1.26",
        env: [
          { name: "GITHUB_TOKEN", valueFrom: { secretKeyRef: { name: "github-token", key: "token" } } },
          { name: "GOFLAGS", value: "-mod=mod" },
        ],
      },
    ],
  },
});
