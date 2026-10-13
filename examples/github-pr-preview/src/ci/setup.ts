// Steps both jobs share: checkout, Node, install, cluster credential.
//
// Every `uses:` is pinned to a full commit SHA — the github lexicon's lint
// treats an unpinned checkout as an error and any other unpinned action as a
// warning. The refs match the lexicon's pin table (`actionRef(slug, "sha")`)
// and carry the release as a `# vX.Y.Z` comment. They are string literals so
// the project still folds. The cluster credential arrives through an env var,
// never interpolated into script text.

import { Step } from "@intentius/chant-lexicon-github";

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0";

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
