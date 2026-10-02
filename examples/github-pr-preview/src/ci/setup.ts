// Steps both jobs share: checkout, Node, install, cluster credential.
//
// Every `uses:` is pinned to a full commit SHA — the github lexicon's lint
// treats an unpinned checkout as an error and any other unpinned action as a
// warning. `actionRef(slug, "sha")` reads the commit from the lexicon's pin
// table and keeps the release as a `# vX.Y.Z` comment. The cluster credential
// arrives through an env var, never interpolated into script text.

import { Step, actionRef } from "@intentius/chant-lexicon-github";

const CHECKOUT = actionRef("actions/checkout", "sha");
const SETUP_NODE = actionRef("actions/setup-node", "sha");

export const checkout = new Step({ name: "Checkout", uses: CHECKOUT });

export const setupNode = new Step({
  name: "Setup Node",
  uses: SETUP_NODE,
  with: { "node-version": "22" },
});

export const install = new Step({ name: "Install", run: "npm ci" });

export const clusterAccess = new Step({
  name: "Configure cluster access",
  env: { KUBECONFIG_DATA: "${{ secrets.PREVIEW_KUBECONFIG }}" },
  run: 'mkdir -p "$HOME/.kube" && printf \'%s\' "$KUBECONFIG_DATA" | base64 -d > "$HOME/.kube/config"',
});
