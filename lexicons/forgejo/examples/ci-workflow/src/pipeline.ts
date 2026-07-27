import {
  Workflow, Job, Step,
  Checkout, SetupNode,
} from "@intentius/chant-lexicon-forgejo";

/**
 * A Node.js build-test-publish pipeline, authored exactly as it would be for
 * GitHub Actions — every entity and composite here comes from the github
 * lexicon (re-exported by @intentius/chant-lexicon-forgejo). The Forgejo
 * dialect is applied on build: `ubuntu-latest` maps to the default Forgejo
 * runner label, and `actions/checkout@v4` / `actions/setup-node@v4` resolve
 * against the configured actions root.
 */
export const workflow = new Workflow({
  name: "CI",
  on: {
    push: { branches: ["main"] },
    pull_request: { branches: ["main"] },
  },
});

export const build = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  steps: [
    Checkout({}).step,
    SetupNode({ nodeVersion: "22", cache: "npm" }).step,
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Build", run: "npm run build" }),
    new Step({ name: "Test", run: "npm test" }),
  ],
});

export const publish = new Job({
  "runs-on": "ubuntu-latest",
  needs: ["build"],
  timeoutMinutes: 10,
  steps: [
    Checkout({}).step,
    SetupNode({ nodeVersion: "22", cache: "npm", registryUrl: "https://code.forgejo.org/api/packages/myorg/npm/" }).step,
    new Step({ name: "Install", run: "npm ci" }),
    new Step({
      name: "Publish package",
      run: "npm publish",
      env: { NODE_AUTH_TOKEN: "${{ secrets.FORGEJO_TOKEN }}" },
    }),
  ],
});
